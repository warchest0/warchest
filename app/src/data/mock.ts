import { getAddress, keccak256, parseEther, parseUnits, stringToBytes, type Address, type Hex } from "viem";
import { DAY, dayOf, weightOf, type Lot } from "@/lib/levels";
import { Side } from "@/lib/options";
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
  VoteProof,
} from "./types";

/**
 * DEMO MODE data provider. Everything here is fabricated but internally consistent (same formulas as the
 * contracts: 20% cap, quorum, LIFO levels, high-water mark) and anchored to the current time so rounds are always
 * live. The UI labels every screen fed by this provider as "Demo data".
 */

/** Wallet used to preview the dashboard without connecting. */
export const DEMO_ACCOUNT: Address = getAddress("0xde30000000000000000000000000000000000de3");

const HOUR = 3600;
const usd = (n: number) => parseUnits(n.toFixed(2), 6);
const tokens = (n: number) => parseEther(String(Math.round(n)));
const now = () => Math.floor(Date.now() / 1000);

/** mulberry32: small deterministic PRNG so the demo world is stable across reloads. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  return Number.parseInt(keccak256(stringToBytes(s)).slice(2, 10), 16);
}

function fakeHash(s: string): Hex {
  return keccak256(stringToBytes(`demo-tx:${s}`));
}

// ---------------------------------------------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------------------------------------------

function demoLots(account: Address, today: number): Lot[] {
  const r = rng(seedOf(account.toLowerCase()));
  return [
    { amount: tokens(180_000 + r() * 720_000), day: today - 12 - Math.floor(r() * 30) },
    { amount: tokens(50_000 + r() * 250_000), day: today - 4 - Math.floor(r() * 4) },
    { amount: tokens(20_000 + r() * 130_000), day: today - 1 - Math.floor(r() * 2) },
    { amount: tokens(10_000 + r() * 70_000), day: today },
  ];
}

interface Holder {
  account: Address;
  weight: bigint;
}

let holderCache: { epoch: number; holders: Holder[] } | undefined;

function crowd(epoch: number): Holder[] {
  if (holderCache?.epoch === epoch) return holderCache.holders;
  const r = rng(424242);
  const holders: Holder[] = [];
  for (let i = 0; i < 320; i++) {
    const balance = (38_000_000 / Math.pow(i + 1, 0.92)) * (0.7 + 0.6 * r());
    const avgLevel = 1 + 9 * Math.pow(r(), 0.6);
    const addr = getAddress(`0x${keccak256(stringToBytes(`holder-${i}`)).slice(26)}`);
    holders.push({ account: addr, weight: tokens(balance * avgLevel) });
  }
  holderCache = { epoch, holders };
  return holders;
}

/** Crowd + an extra account (the viewer), sorted by weight. */
function ranked(epoch: number, extra?: Holder): Holder[] {
  const all = [...crowd(epoch)];
  if (extra && !all.some((h) => h.account === extra.account)) all.push(extra);
  return all.sort((a, b) => (a.weight === b.weight ? 0 : a.weight > b.weight ? -1 : 1));
}

const totalOf = (hs: Holder[]) => hs.reduce((s, h) => s + h.weight, 0n);

// ---------------------------------------------------------------------------------------------------------------
// Rounds
// ---------------------------------------------------------------------------------------------------------------

const QUORUM_BPS = 1000;
const VOTING_PERIOD = DAY;
const ROUND_ASSETS = [0, 1, 5]; // BTC, ETH, SOL
/** Option shares at the end of the round: BTC L/S, ETH L/S, SOL L/S. */
const SHARES = [0.29, 0.07, 0.37, 0.1, 0.13, 0.04];
const TURNOUT = 0.13;
const CURRENT_ROUND_ID = 14n;

/** Votes cast from the UI in demo mode, per round: account → (option, weight). */
const demoVotes = new Map<bigint, Map<string, { option: number; weight: bigint }>>();
let demoClaimed: bigint | undefined;

function currentRoundWindow(t: number) {
  // rounds open every day at 02:00 UTC and last 24 h, so one is always live
  const startsAt = dayOf(t - 2 * HOUR) * DAY + 2 * HOUR;
  return { startsAt, endsAt: startsAt + VOTING_PERIOD, epoch: dayOf(startsAt) - 1 };
}

function directionRound(account?: Address): RoundView {
  const t = now();
  const { startsAt, endsAt, epoch } = currentRoundWindow(t);
  const totalWeight = totalOf(crowd(epoch));
  const p = Math.min(1, (t - startsAt) / VOTING_PERIOD);
  // turnout ramps up during the round; shares wobble a little so the bars feel alive
  const voted = TURNOUT * (0.3 + 0.7 * Math.sqrt(p));
  const raw = SHARES.map((s, i) => s * (1 + 0.09 * Math.sin(p * 9 + i * 1.7)));
  const norm = raw.reduce((a, b) => a + b, 0);
  const base = Number(totalWeight / 10n ** 15n);
  const tallies = raw.map((s) => (BigInt(Math.floor(base * voted * (s / norm))) * 10n ** 15n) as bigint);
  const votes = demoVotes.get(CURRENT_ROUND_ID);
  let hasVoted = false;
  if (votes) {
    for (const [voter, v] of votes) {
      tallies[v.option] = (tallies[v.option] ?? 0n) + v.weight;
      if (account && voter === account.toLowerCase()) hasVoted = true;
    }
  }
  return {
    id: CURRENT_ROUND_ID,
    kind: "direction",
    epoch,
    startsAt,
    endsAt,
    finalized: false,
    voided: false,
    totalVoted: tallies.reduce((a, b) => a + b, 0n),
    totalWeight,
    quorumBps: QUORUM_BPS,
    assets: ROUND_ASSETS,
    tallies,
    targetDecisionId: 0n,
    hasVoted,
    voters: Math.floor(41 + 180 * Math.sqrt(p)) + (votes?.size ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Treasury history
// ---------------------------------------------------------------------------------------------------------------

const DECISIONS: { id: number; asset: number; side: Side; pnl: number; daysAgo: number; round: number }[] = [
  { id: 1, asset: 0, side: Side.Long, pnl: 48_210, daysAgo: 74, round: 2 },
  { id: 2, asset: 5, side: Side.Short, pnl: -21_870, daysAgo: 66, round: 3 },
  { id: 3, asset: 1, side: Side.Long, pnl: 61_340, daysAgo: 57, round: 4 },
  { id: 4, asset: 1, side: Side.Short, pnl: 15_020, daysAgo: 45, round: 6 },
  { id: 5, asset: 0, side: Side.Long, pnl: -35_110, daysAgo: 36, round: 7 },
  { id: 6, asset: 1, side: Side.Long, pnl: 72_480, daysAgo: 27, round: 8 },
  { id: 7, asset: 5, side: Side.Long, pnl: -9_150, daysAgo: 18, round: 9 },
  { id: 8, asset: 0, side: Side.Short, pnl: 55_500, daysAgo: 9, round: 11 },
];
const CUMULATIVE_PNL = DECISIONS.reduce((s, d) => s + d.pnl, 0);
const HWM = 120_000;
const NAV = 1_842_310.44;
const OPEN = { id: 9, asset: 1, side: Side.Long, capital: 352_000, equity: 371_452.18, openedHoursAgo: 31, round: 13 };

function treasury(): TreasuryState {
  const t = now();
  const anchor = Math.floor(t / HOUR) * HOUR;
  return {
    nav: usd(NAV),
    usdgLedger: usd(1_561_904.12),
    maxOrder: usd(NAV * 0.2),
    capBps: 2000,
    paused: false,
    mustClose: false,
    position: {
      decisionId: BigInt(OPEN.id),
      asset: OPEN.asset,
      side: OPEN.side,
      capital: usd(OPEN.capital),
      openedAt: anchor - OPEN.openedHoursAgo * HOUR,
      closeReportedAt: 0,
      equity: usd(OPEN.equity),
    },
    risk: { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 },
    cumulativePnl: usd(CUMULATIVE_PNL),
    highWaterMark: usd(HWM),
    // realized profit above the HWM is only distributable while no position is open
    distributable: 0n,
    distributorEnabled: true,
    closeVoteAllowed: false,
    feesEth: parseEther("112.84"),
  };
}

function pnlHistory(): PnlPoint[] {
  const t = now();
  let cum = 0;
  const pts: PnlPoint[] = [{ timestamp: t - 82 * DAY, cumulativePnl: 0 }];
  for (const d of DECISIONS) {
    cum += d.pnl;
    pts.push({ timestamp: t - d.daysAgo * DAY, cumulativePnl: cum });
  }
  pts.push({ timestamp: t, cumulativePnl: cum });
  return pts;
}

function vaultEvents(): VaultEvent[] {
  const t = now();
  const anchor = Math.floor(t / (10 * 60)) * 10 * 60;
  const r = rng(777);
  const ev: VaultEvent[] = [];
  for (let i = 0; i < 18; i++) {
    const ts = anchor - Math.floor((i * 3.7 + r() * 2) * HOUR);
    const eth = (0.3 + r() * 2.1).toFixed(3);
    ev.push({ id: `fee-${i}`, kind: "fee", timestamp: ts, txHash: fakeHash(`fee${i}`), title: "Swap fees received", detail: `${eth} ETH from the hook` });
  }
  for (let i = 0; i < 6; i++) {
    const ts = anchor - Math.floor((2 + i * 11.3) * HOUR);
    const eth = (6 + r() * 14).toFixed(2);
    const out = (Number(eth) * (2640 + r() * 60)).toLocaleString("en-US", { maximumFractionDigits: 0 });
    ev.push({ id: `conv-${i}`, kind: "conversion", timestamp: ts, txHash: fakeHash(`conv${i}`), title: "ETH → USDG conversion", detail: `${eth} ETH → ${out} USDG (TWAP-floored)` });
  }
  ev.push({ id: "order-9", kind: "order", timestamp: anchor - OPEN.openedHoursAgo * HOUR, txHash: fakeHash("order9"), title: "Order executed · decision #9", detail: `ETH Long · $352,000 bridged to Hyperliquid · 3× · SL 5% · TP 10%` });
  ev.push({ id: "report-9a", kind: "report", timestamp: anchor - 24 * HOUR, txHash: fakeHash("rep9a"), title: "Equity report · decision #9", detail: "$358,120 (final after 6 h challenge window)" });
  ev.push({ id: "report-9b", kind: "report", timestamp: anchor - 12 * HOUR, txHash: fakeHash("rep9b"), title: "Equity report · decision #9", detail: "$371,452 (final after 6 h challenge window)" });
  ev.push({ id: "closerep-8", kind: "closeReported", timestamp: anchor - 41 * HOUR, txHash: fakeHash("cr8"), title: "Close reported · decision #8", detail: "Superseded by decision #9: close then reopen" });
  ev.push({ id: "closed-8", kind: "closed", timestamp: anchor - 35 * HOUR, txHash: fakeHash("cl8"), title: "Position closed · decision #8", detail: "BTC Short · returned $393,500 on $338,000", pnl: usd(55_500) });
  return ev.sort((a, b) => b.timestamp - a.timestamp);
}

function pastRounds(): PastRound[] {
  const t = now();
  const tw = (n: number) => tokens(n);
  const rounds: PastRound[] = [
    { id: 13n, kind: "direction", endsAt: t - 32 * HOUR, outcome: "decision", quorate: true, totalVoted: tw(412e6), totalWeight: tw(2_890e6), winner: { option: 2, asset: 1, side: Side.Long, weight: tw(171e6) } },
    { id: 12n, kind: "close", endsAt: t - 3 * DAY, outcome: "keep", quorate: true, totalVoted: tw(356e6), totalWeight: tw(2_850e6), winner: { option: 0, weight: tw(201e6) } },
    { id: 11n, kind: "direction", endsAt: t - 9.2 * DAY, outcome: "decision", quorate: true, totalVoted: tw(398e6), totalWeight: tw(2_790e6), winner: { option: 1, asset: 0, side: Side.Short, weight: tw(160e6) }, pnl: usd(55_500) },
    { id: 10n, kind: "direction", endsAt: t - 13 * DAY, outcome: "fallback", quorate: false, totalVoted: tw(198e6), totalWeight: tw(2_760e6), winner: { option: 0, asset: 0, side: Side.Long, weight: tw(88e6) } },
    { id: 9n, kind: "direction", endsAt: t - 18.2 * DAY, outcome: "decision", quorate: true, totalVoted: tw(344e6), totalWeight: tw(2_710e6), winner: { option: 4, asset: 5, side: Side.Long, weight: tw(139e6) }, pnl: usd(-9_150) },
    { id: 8n, kind: "direction", endsAt: t - 27.2 * DAY, outcome: "decision", quorate: true, totalVoted: tw(367e6), totalWeight: tw(2_640e6), winner: { option: 2, asset: 1, side: Side.Long, weight: tw(190e6) }, pnl: usd(72_480) },
    { id: 7n, kind: "direction", endsAt: t - 36.2 * DAY, outcome: "decision", quorate: true, totalVoted: tw(301e6), totalWeight: tw(2_580e6), winner: { option: 0, asset: 0, side: Side.Long, weight: tw(122e6) }, pnl: usd(-35_110) },
    { id: 6n, kind: "direction", endsAt: t - 45.2 * DAY, outcome: "decision", quorate: true, totalVoted: tw(289e6), totalWeight: tw(2_490e6), winner: { option: 3, asset: 1, side: Side.Short, weight: tw(117e6) }, pnl: usd(15_020) },
    { id: 5n, kind: "direction", endsAt: t - 51 * DAY, outcome: "void", quorate: false, totalVoted: tw(92e6), totalWeight: tw(2_430e6) },
  ];
  return rounds;
}

// ---------------------------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function holderState(account: Address): HolderState {
  const today = dayOf(now());
  const lots = demoLots(account, today);
  const epoch = today - 1;
  const snapshotWeight = weightOf(lots, epoch);
  const list = ranked(epoch, { account, weight: snapshotWeight });
  const rank = list.findIndex((h) => h.account === account) + 1;
  return {
    account,
    balance: lots.reduce((s, l) => s + l.amount, 0n),
    lots,
    snapshotWeight,
    snapshotEpoch: epoch,
    rank,
    holders: list.length,
  };
}

export const demoProvider: DataProvider & {
  castVote(roundId: bigint, option: number, account: Address): Promise<Hex>;
  claim(account: Address): Promise<Hex>;
} = {
  mode: "demo",
  async getTreasury() {
    await sleep(250);
    return treasury();
  },
  async getVaultEvents() {
    await sleep(300);
    return vaultEvents();
  },
  async getPnlHistory() {
    await sleep(200);
    return pnlHistory();
  },
  async getActiveRounds(account) {
    await sleep(200);
    const rounds: ActiveRounds = { direction: directionRound(account), close: null, paused: false };
    return rounds;
  },
  async getPastRounds() {
    await sleep(250);
    return pastRounds();
  },
  async getHolder(account) {
    await sleep(250);
    return holderState(account);
  },
  async getLeaderboard() {
    await sleep(300);
    const epoch = dayOf(now()) - 1;
    const list = ranked(epoch);
    const total = totalOf(list);
    const board: Leaderboard = {
      epoch,
      totalWeight: total,
      rootVerified: null,
      entries: list.map((h, i) => ({
        rank: i + 1,
        account: h.account,
        weight: h.weight,
        share: Number((h.weight * 1_000_000n) / total) / 1_000_000,
      })),
    };
    return board;
  },
  async getVoteProof(_epoch, account): Promise<VoteProof | null> {
    const h = holderState(account);
    return h.snapshotWeight && h.snapshotWeight > 0n ? { weight: h.snapshotWeight, proof: [] } : null;
  },
  async getClaim(): Promise<ClaimState> {
    await sleep(200);
    const cumulative = usd(412.35);
    const claimed = demoClaimed ?? usd(250);
    return { enabled: true, cumulative, claimed, claimable: cumulative - claimed, proof: [] };
  },
  async castVote(roundId, option, account) {
    await sleep(1200);
    const proof = await this.getVoteProof(0, account);
    if (!proof) throw new Error("No voting weight in the snapshot");
    const votes = demoVotes.get(roundId) ?? new Map();
    if (votes.has(account.toLowerCase())) throw new Error("Already voted in this round");
    votes.set(account.toLowerCase(), { option, weight: proof.weight });
    demoVotes.set(roundId, votes);
    return fakeHash(`vote-${roundId}-${account}`);
  },
  async claim(account) {
    await sleep(1200);
    demoClaimed = usd(412.35);
    return fakeHash(`claim-${account}`);
  },
};
