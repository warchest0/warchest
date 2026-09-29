import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { distributorAbi, governanceAbi, tokenAbi, vaultAbi } from "@/abi";
import { env } from "@/config/env";
import { assetMeta } from "@/config/assets";
import { DAY, dayOf, type Lot } from "@/lib/levels";
import { fmtUsd } from "@/lib/format";
import { reconstructLots, LOT_WINDOW_DAYS, type WalletTransfer } from "@/lib/lots";
import { decodeOption, isQuorate, sideLabel, uniqueLeader, type Side } from "@/lib/options";
import {
  findClaimProof,
  findWeightProof,
  parseTreeDump,
  treeRoot,
  treeUrl,
  verifyProof,
  weightEntries,
  weightLeaf,
  type StandardTreeDump,
} from "@/lib/tree";
import { blockTimestamps, scanBackward, type DecodedLog } from "./logs";
import type {
  ActiveRounds,
  ClaimState,
  DataProvider,
  HolderState,
  Leaderboard,
  PastRound,
  PnlPoint,
  RoundView,
  TreasuryState,
  VaultEvent,
  VaultEventKind,
} from "./types";

/**
 * On-chain data provider: reads `WarchestGovernance`, `WarchestVault`, the token and the optional distributor
 * directly over JSON-RPC, plus the weight tree JSON published by the indexer. No backend.
 */
let _client: PublicClient | undefined;
export function publicClient(): PublicClient {
  _client ??= createPublicClient({
    chain: env.chain,
    transport: http(env.rpcUrl, { batch: { batchSize: 50 }, retryCount: 3 }),
  }) as PublicClient;
  return _client;
}

function need<T>(v: T | undefined, name: string): T {
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

const gov = () => ({ address: need(env.governance, "NEXT_PUBLIC_GOVERNANCE"), abi: governanceAbi }) as const;
const vault = () => ({ address: need(env.vault, "NEXT_PUBLIC_VAULT"), abi: vaultAbi }) as const;

// ---------------------------------------------------------------------------------------------------------------
// Weight trees (cached per epoch)
// ---------------------------------------------------------------------------------------------------------------

const treeCache = new Map<number, Promise<StandardTreeDump>>();

export function fetchWeightTree(epoch: number): Promise<StandardTreeDump> {
  if (!env.treeUrlTemplate) return Promise.reject(new Error("NEXT_PUBLIC_TREE_URL_TEMPLATE is not configured"));
  let p = treeCache.get(epoch);
  if (!p) {
    p = fetch(treeUrl(env.treeUrlTemplate, epoch))
      .then((r) => {
        if (!r.ok) throw new Error(`weight tree for epoch ${epoch}: HTTP ${r.status}`);
        return r.json();
      })
      .then(parseTreeDump);
    p.catch(() => treeCache.delete(epoch));
    treeCache.set(epoch, p);
  }
  return p;
}

async function onchainRoot(epoch: number) {
  const c = publicClient();
  return c.readContract({ ...gov(), functionName: "weightRoot", args: [BigInt(epoch)] });
}

// ---------------------------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------------------------

async function readRound(roundId: bigint, account?: Address): Promise<RoundView> {
  const c = publicClient();
  const [r, assets, quorumBps, voided, hasVoted] = await Promise.all([
    c.readContract({ ...gov(), functionName: "getRound", args: [roundId] }),
    c.readContract({ ...gov(), functionName: "roundAssets", args: [roundId] }),
    c.readContract({ ...gov(), functionName: "quorumBps" }),
    c.readContract({ ...gov(), functionName: "voided", args: [roundId] }),
    account ? c.readContract({ ...gov(), functionName: "hasVoted", args: [roundId, account] }) : Promise.resolve(false),
  ]);
  const kind = r.kind === 0 ? "direction" : "close";
  const n = kind === "direction" ? assets.length * 2 : 2;
  const [root, ...tallies] = await Promise.all([
    onchainRoot(Number(r.epoch)),
    ...Array.from({ length: n }, (_, o) => c.readContract({ ...gov(), functionName: "tally", args: [roundId, BigInt(o)] })),
  ]);
  return {
    id: roundId,
    kind,
    epoch: Number(r.epoch),
    startsAt: Number(r.startsAt),
    endsAt: Number(r.endsAt),
    finalized: r.finalized,
    voided,
    totalVoted: r.totalVoted,
    totalWeight: root.totalWeight,
    quorumBps: Number(quorumBps),
    assets: assets.map(Number),
    tallies,
    targetDecisionId: r.targetDecisionId,
    hasVoted,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Vault events
// ---------------------------------------------------------------------------------------------------------------

const VAULT_EVENTS = vaultAbi.filter((x) => x.type === "event");

function describe(l: DecodedLog): { kind: VaultEventKind; title: string; detail: string; pnl?: bigint } | null {
  const a = l.args as Record<string, bigint | number | boolean | string>;
  switch (l.eventName) {
    case "EthReceived":
      return { kind: "fee", title: "ETH received", detail: `${(Number(a.amount) / 1e18).toFixed(3)} ETH` };
    case "EthConverted":
      return { kind: "conversion", title: "ETH → USDG conversion", detail: `${(Number(a.ethIn) / 1e18).toFixed(3)} ETH → ${fmtUsd(a.usdgOut as bigint)}` };
    case "OrderExecuted":
      return {
        kind: "order",
        title: `Order executed · decision #${a.decisionId}`,
        detail: `${assetMeta(Number(a.asset)).symbol} ${sideLabel(Number(a.side) as Side)} · ${fmtUsd(a.capital as bigint)} · ${a.leverage}× · SL ${Number(a.stopLossBps) / 100}% · TP ${Number(a.takeProfitBps) / 100}%`,
      };
    case "PositionReported":
      return { kind: "report", title: `Equity report · decision #${a.decisionId}`, detail: `${fmtUsd(a.equity as bigint)} (challenge window)` };
    case "CloseReported":
      return { kind: "closeReported", title: `Close reported · decision #${a.decisionId}`, detail: "Final after the challenge window" };
    case "PositionClosed":
      return {
        kind: "closed",
        title: `Position closed · decision #${a.decisionId}`,
        detail: `Returned ${fmtUsd(a.returned as bigint)} on ${fmtUsd(a.capital as bigint)}`,
        pnl: a.pnl as bigint,
      };
    case "LateReturn":
      return { kind: "lateReturn", title: `Late return · decision #${a.decisionId}`, detail: fmtUsd(a.amount as bigint) };
    case "Distributed":
      return { kind: "distributed", title: "Profit sent to distributor", detail: fmtUsd(a.amount as bigint) };
    case "Paused":
      return { kind: "paused", title: a.paused ? "Vault paused by guardian" : "Vault unpaused", detail: "" };
    default:
      return null;
  }
}

async function withTimestamps(logs: DecodedLog[]) {
  const ts = await blockTimestamps(publicClient(), logs.map((l) => l.blockNumber));
  return logs.map((l) => ({ log: l, timestamp: ts.get(l.blockNumber) ?? 0 }));
}

// ---------------------------------------------------------------------------------------------------------------
// Lot book
// ---------------------------------------------------------------------------------------------------------------

async function indexerLots(account: Address): Promise<{ balance: bigint; lots: Lot[] } | undefined> {
  if (!env.indexerApi) return undefined;
  const res = await fetch(`${env.indexerApi}/account/${account}`);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { balance: string; lots: { amount: string; acquiredDay: number }[] };
  return { balance: BigInt(body.balance), lots: body.lots.map((l) => ({ amount: BigInt(l.amount), day: l.acquiredDay })) };
}

async function lotsFromLogs(account: Address, balance: bigint, windowStart: number): Promise<Lot[]> {
  const c = publicClient();
  const token = need(env.token, "NEXT_PUBLIC_TOKEN");
  const since = windowStart * DAY;
  const transfer = tokenAbi.filter((x) => x.type === "event");
  const [inLogs, outLogs] = await Promise.all([
    scanBackward(c, { address: token, events: transfer, args: { to: account }, fromBlock: env.startBlock, chunk: env.logChunk, sinceTimestamp: since, maxChunks: 400 }),
    scanBackward(c, { address: token, events: transfer, args: { from: account }, fromBlock: env.startBlock, chunk: env.logChunk, sinceTimestamp: since, maxChunks: 400 }),
  ]);
  const all = [...inLogs, ...outLogs]
    .filter((l) => (l.args.from as string).toLowerCase() !== (l.args.to as string).toLowerCase())
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const ts = await blockTimestamps(c, all.map((l) => l.blockNumber));
  const transfers: WalletTransfer[] = all
    .map((l) => ({ l, t: ts.get(l.blockNumber) ?? 0 }))
    .filter(({ t }) => t >= since)
    .map(({ l, t }) => ({
      day: dayOf(t),
      delta: (l.args.to as string).toLowerCase() === account.toLowerCase() ? (l.args.value as bigint) : -(l.args.value as bigint),
    }));
  return reconstructLots(balance, transfers, windowStart);
}

// ---------------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------------

export const onchainProvider: DataProvider = {
  mode: "onchain",

  async getTreasury(): Promise<TreasuryState> {
    const c = publicClient();
    const v = vault();
    const [nav, usdgLedger, maxOrder, capBps, paused, pos, mustClose, risk, cumulativePnl, hwm, distributable, distributor] =
      await Promise.all([
        c.readContract({ ...v, functionName: "nav" }),
        c.readContract({ ...v, functionName: "usdgLedger" }),
        c.readContract({ ...v, functionName: "maxOrderAmount" }),
        c.readContract({ ...v, functionName: "capBps" }),
        c.readContract({ ...v, functionName: "paused" }),
        c.readContract({ ...v, functionName: "position" }),
        c.readContract({ ...v, functionName: "mustClose" }),
        c.readContract({ ...v, functionName: "riskParams" }),
        c.readContract({ ...v, functionName: "cumulativePnl" }),
        c.readContract({ ...v, functionName: "highWaterMark" }),
        c.readContract({ ...v, functionName: "distributable" }),
        c.readContract({ ...v, functionName: "distributor" }),
      ]);
    let equity: bigint | undefined;
    let closeVoteAllowed = false;
    if (pos.decisionId !== 0n) {
      const [[eq, exists], allowed] = await Promise.all([
        c.readContract({ ...v, functionName: "finalizedEquity", args: [pos.decisionId] }),
        c.readContract({ ...v, functionName: "closeVoteAllowed", args: [pos.decisionId] }),
      ]);
      equity = exists ? eq : undefined;
      closeVoteAllowed = allowed;
    }
    return {
      nav,
      usdgLedger,
      maxOrder,
      capBps: Number(capBps),
      paused,
      mustClose,
      position:
        pos.decisionId === 0n
          ? null
          : {
              decisionId: pos.decisionId,
              asset: Number(pos.asset),
              side: pos.side as Side,
              capital: pos.capital,
              openedAt: Number(pos.openedAt),
              closeReportedAt: Number(pos.closeReportedAt),
              equity,
            },
      risk: { stopLossBps: Number(risk[0]), leverage: Number(risk[1]), takeProfitBps: Number(risk[2]) },
      cumulativePnl,
      highWaterMark: hwm,
      distributable,
      distributorEnabled: distributor !== "0x0000000000000000000000000000000000000000",
      closeVoteAllowed,
    };
  },

  async getVaultEvents(): Promise<VaultEvent[]> {
    const logs = await scanBackward(publicClient(), {
      address: vault().address,
      events: VAULT_EVENTS,
      fromBlock: env.startBlock,
      chunk: env.logChunk,
      limit: 40,
      maxChunks: 30,
    });
    const recent = logs.slice(-40);
    const stamped = await withTimestamps(recent);
    return stamped
      .map(({ log, timestamp }) => {
        const d = describe(log);
        const ev: VaultEvent | null = d ? { id: `${log.transactionHash}-${log.logIndex}`, timestamp, txHash: log.transactionHash, ...d } : null;
        return ev;
      })
      .filter((x): x is VaultEvent => x !== null)
      .reverse();
  },

  async getPnlHistory(): Promise<PnlPoint[]> {
    const closed = VAULT_EVENTS.filter((e) => e.name === "PositionClosed" || e.name === "LateReturn");
    const logs = await scanBackward(publicClient(), {
      address: vault().address,
      events: closed,
      fromBlock: env.startBlock,
      chunk: env.logChunk,
      maxChunks: 60,
    });
    const stamped = await withTimestamps(logs);
    const pts: PnlPoint[] = stamped.map(({ log, timestamp }) => ({
      timestamp,
      cumulativePnl: Number(log.args.cumulativePnl as bigint) / 1e6,
    }));
    const first = pts[0];
    if (first) pts.unshift({ timestamp: first.timestamp - DAY, cumulativePnl: 0 });
    return pts;
  },

  async getActiveRounds(account): Promise<ActiveRounds> {
    const c = publicClient();
    const [dirId, closeId, paused] = await Promise.all([
      c.readContract({ ...gov(), functionName: "activeRound", args: [0] }),
      c.readContract({ ...gov(), functionName: "activeRound", args: [1] }),
      c.readContract({ ...gov(), functionName: "paused" }),
    ]);
    const [direction, close] = await Promise.all([
      dirId === 0n ? null : readRound(dirId, account),
      closeId === 0n ? null : readRound(closeId, account),
    ]);
    return { direction, close, paused };
  },

  async getPastRounds(): Promise<PastRound[]> {
    const c = publicClient();
    const count = await c.readContract({ ...gov(), functionName: "roundCount" });
    const ids: bigint[] = [];
    for (let id = count; id > 0n && ids.length < 12; id--) ids.push(id);
    const rounds = await Promise.all(ids.map((id) => readRound(id)));
    return rounds
      .filter((r) => r.finalized || r.endsAt * 1000 < Date.now())
      .map((r) => {
        const quorate = isQuorate(r.totalVoted, r.totalWeight, r.quorumBps);
        const lead = uniqueLeader(r.tallies);
        let outcome: PastRound["outcome"];
        if (!r.finalized) outcome = "pending";
        else if (r.voided) outcome = "void";
        else if (r.kind === "direction") outcome = quorate && lead >= 0 ? "decision" : "fallback";
        else outcome = quorate && lead === 1 ? "close" : "keep";
        const winner =
          lead < 0
            ? undefined
            : r.kind === "direction"
              ? { ...decodeOption(lead, r.assets), weight: r.tallies[lead]! }
              : { option: lead, weight: r.tallies[lead]! };
        return { id: r.id, kind: r.kind, endsAt: r.endsAt, outcome, quorate, totalVoted: r.totalVoted, totalWeight: r.totalWeight, winner };
      });
  },

  async getHolder(account): Promise<HolderState> {
    const c = publicClient();
    const token = need(env.token, "NEXT_PUBLIC_TOKEN");
    const today = dayOf(Math.floor(Date.now() / 1000));
    const windowStart = today - LOT_WINDOW_DAYS;
    const balance = await c.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [account] });
    // the indexer API knows every lot's exact day; it trails the chain head by the finalization delay, so it is only
    // used when its balance matches the chain, otherwise the lot book is rebuilt from recent transfer logs
    const fromApi = await indexerLots(account).catch(() => undefined);
    const lots = fromApi && fromApi.balance === balance ? fromApi.lots : await lotsFromLogs(account, balance, windowStart);

    const state: HolderState = { account, balance, lots, approximate: !fromApi && lots.some((l) => l.day < windowStart) };
    try {
      const epoch = Number(await c.readContract({ ...gov(), functionName: "latestEpoch" }));
      if (epoch > 0) {
        const dump = await fetchWeightTree(epoch);
        const entries = weightEntries(dump).sort((a, b) => (a.weight === b.weight ? 0 : a.weight > b.weight ? -1 : 1));
        const i = entries.findIndex((e) => e.account.toLowerCase() === account.toLowerCase());
        state.snapshotEpoch = epoch;
        state.holders = entries.length;
        if (i >= 0) {
          state.snapshotWeight = entries[i]!.weight;
          state.rank = i + 1;
        } else state.snapshotWeight = 0n;
      }
    } catch {
      // the tree is optional for the dashboard: levels are computed from transfers anyway
    }
    return state;
  },

  async getLeaderboard(): Promise<Leaderboard> {
    const c = publicClient();
    const epoch = Number(await c.readContract({ ...gov(), functionName: "latestEpoch" }));
    if (epoch === 0) return { epoch: 0, totalWeight: 0n, entries: [], rootVerified: null };
    const [dump, root] = await Promise.all([fetchWeightTree(epoch), onchainRoot(epoch)]);
    const entries = weightEntries(dump).sort((a, b) => (a.weight === b.weight ? 0 : a.weight > b.weight ? -1 : 1));
    const total = entries.reduce((s, e) => s + e.weight, 0n);
    return {
      epoch,
      totalWeight: total,
      rootVerified: treeRoot(dump).toLowerCase() === root.root.toLowerCase(),
      entries: entries.map((e, i) => ({
        rank: i + 1,
        account: e.account,
        weight: e.weight,
        share: total === 0n ? 0 : Number((e.weight * 1_000_000n) / total) / 1_000_000,
      })),
    };
  },

  async getVoteProof(epoch, account) {
    if (env.indexerApi) {
      const [res, root] = await Promise.all([fetch(`${env.indexerApi}/proof/${epoch}/${account}`), onchainRoot(epoch)]);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`indexer proof: HTTP ${res.status}`);
      const body = (await res.json()) as { weight: string; proof: Hex[] };
      const weight = BigInt(body.weight);
      const leaf = weightLeaf(env.chainId, gov().address, epoch, account, weight);
      if (!verifyProof(root.root, leaf, body.proof)) throw new Error("The indexer's proof does not match the on-chain root");
      return { weight, proof: body.proof };
    }
    const [dump, root] = await Promise.all([fetchWeightTree(epoch), onchainRoot(epoch)]);
    if (treeRoot(dump).toLowerCase() !== root.root.toLowerCase()) {
      throw new Error("The published weight tree does not match the on-chain root");
    }
    const found = findWeightProof(dump, account, { chainId: env.chainId, governance: gov().address, epoch });
    return found ? { weight: found.weight, proof: found.proof } : null;
  },

  async getClaim(account): Promise<ClaimState | null> {
    if (!env.distributor || !env.distributionTreeUrl) return null;
    const c = publicClient();
    const [claimed, res] = await Promise.all([
      c.readContract({ address: env.distributor, abi: distributorAbi, functionName: "claimed", args: [account] }),
      fetch(env.distributionTreeUrl).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    ]);
    const found = findClaimProof(parseTreeDump(res), account);
    const cumulative = found?.cumulativeAmount ?? 0n;
    return {
      enabled: true,
      cumulative,
      claimed,
      claimable: cumulative > claimed ? cumulative - claimed : 0n,
      proof: found?.proof ?? [],
    };
  },
};
