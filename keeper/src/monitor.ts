/**
 * Independent monitor. It shares NO state with the trading loop: it only reads the vault, governance and Hyperliquid
 * and checks that what the account shows is exactly what the decision and the vault's risk parameters allow.
 * Run it in-process on its own interval or as a separate process (`keeper monitor`). A red finding is alerted and,
 * when `MONITOR_KILL=1`, triggers the kill switch.
 */
import type { Address } from "viem";
import type { ChainReader } from "./chain/reader.js";
import type { CloseResult } from "./executor.js";
import type { HyperliquidInfo } from "./hyperliquid/info.js";
import { absDecimal, cmpDecimals, decimalToUsd6, mulBps } from "./hyperliquid/rounding.js";
import { Alerts, Logger } from "./log.js";
import { formatUsd6, protectionPrices } from "./planner.js";
import type { GovernanceSnapshot, HlAccountState, HlAgent, HlOpenOrder, PerpMeta, VaultSnapshot } from "./types.js";

export type Level = "red" | "yellow";

export interface Finding {
  level: Level;
  code:
    | "FOREIGN_POSITION"
    | "POSITION_WITHOUT_VAULT"
    | "ASSET_MISMATCH"
    | "SIDE_MISMATCH"
    | "MARGIN_MODE"
    | "LEVERAGE"
    | "SIZE_EXCEEDS"
    | "STOP_MISSING"
    | "STOP_TOO_FAR"
    | "UNEXPECTED_ORDER"
    | "AGENT_MISSING"
    | "AGENT_EXPIRING"
    | "MUST_CLOSE"
    | "ASSET_NOT_ALLOWED";
  detail: string;
}

export interface MonitorInput {
  vault: VaultSnapshot;
  gov: GovernanceSnapshot;
  state: HlAccountState;
  orders: HlOpenOrder[];
  agents: HlAgent[];
  universe: PerpMeta[];
  allowedAssets: string[];
  agentAddress?: Address;
  agentExpiryWarnMs: number;
  /** Tolerance on position value vs capital × leverage (bps). */
  sizeToleranceBps: number;
  now: number;
}

/** Pure invariant check. */
export function checkInvariants(i: MonitorInput): Finding[] {
  const f: Finding[] = [];
  const vp = i.vault.position;
  const perp = vp.decisionId !== 0n ? i.universe[vp.asset] : undefined;
  const expectedCoin = perp?.name;

  for (const p of i.state.positions) {
    if (cmpDecimals(absDecimal(p.szi), "0") === 0) continue;
    if (vp.decisionId === 0n) {
      f.push({ level: "red", code: "POSITION_WITHOUT_VAULT", detail: `${p.coin} ${p.szi} open while the vault has no position` });
      continue;
    }
    if (p.coin !== expectedCoin) {
      f.push({ level: "red", code: p.coin && i.allowedAssets.includes(p.coin) ? "FOREIGN_POSITION" : "ASSET_NOT_ALLOWED", detail: `${p.coin} ${p.szi} open, decision is ${expectedCoin}` });
      continue;
    }
    const isLong = !p.szi.startsWith("-");
    if ((vp.side === "long") !== isLong) f.push({ level: "red", code: "SIDE_MISMATCH", detail: `${p.coin} is ${isLong ? "long" : "short"}, decision is ${vp.side}` });
    if (p.leverageType !== "isolated") f.push({ level: "red", code: "MARGIN_MODE", detail: `${p.coin} is ${p.leverageType}, must be isolated` });
    if (p.leverage !== i.vault.risk.leverage) f.push({ level: "red", code: "LEVERAGE", detail: `${p.coin} leverage ${p.leverage} != vault ${i.vault.risk.leverage}` });
    const maxValue = mulBps(mulBps(formatUsd6(vp.capital), i.vault.risk.leverage * 10_000), 10_000 + i.sizeToleranceBps);
    if (cmpDecimals(absDecimal(p.positionValue), maxValue) > 0) {
      f.push({ level: "red", code: "SIZE_EXCEEDS", detail: `${p.coin} value ${p.positionValue} > capital × leverage ${maxValue}` });
    }
    const stops = i.orders.filter((o) => o.coin === p.coin && o.isTrigger && o.reduceOnly && o.orderType.toLowerCase().includes("stop") && o.side === (isLong ? "A" : "B"));
    if (stops.length === 0) f.push({ level: "red", code: "STOP_MISSING", detail: `${p.coin} has no reduce-only stop` });
    else if (p.entryPx && perp) {
      const { stopLossPx } = protectionPrices(p.entryPx, vp.side, i.vault.risk, perp.szDecimals);
      // the stop must not be further from the entry than the vault mandates (a little slack for rounding)
      const tooFar = stops.every((s) => (isLong ? cmpDecimals(s.triggerPx, mulBps(stopLossPx, 9_950)) < 0 : cmpDecimals(s.triggerPx, mulBps(stopLossPx, 10_050)) > 0));
      if (tooFar) f.push({ level: "red", code: "STOP_TOO_FAR", detail: `${p.coin} stop ${stops.map((s) => s.triggerPx).join(",")} beyond the mandated ${stopLossPx}` });
    }
    if (i.vault.mustClose) f.push({ level: "yellow", code: "MUST_CLOSE", detail: `vault says mustClose (paused=${i.vault.paused}, closeRequested=${i.gov.closeRequested}, current decision ${i.gov.decision.id})` });
  }

  for (const o of i.orders) {
    const legit = o.reduceOnly && o.isTrigger && o.coin === expectedCoin;
    if (!legit) f.push({ level: o.reduceOnly ? "yellow" : "red", code: "UNEXPECTED_ORDER", detail: `${o.coin} ${o.orderType} ${o.side} ${o.sz} @ ${o.limitPx} (oid ${o.oid}, reduceOnly=${o.reduceOnly})` });
  }

  if (i.agentAddress) {
    const me = i.agents.find((a) => a.address.toLowerCase() === i.agentAddress!.toLowerCase());
    if (!me) f.push({ level: "red", code: "AGENT_MISSING", detail: `agent ${i.agentAddress} is not approved on the account` });
    else if (me.validUntil - i.now < i.agentExpiryWarnMs) f.push({ level: "yellow", code: "AGENT_EXPIRING", detail: `agent ${me.name} expires at ${new Date(me.validUntil).toISOString()}` });
  }
  return f;
}

export interface MonitorDeps {
  chain: ChainReader;
  hl: HyperliquidInfo;
  alerts: Alerts;
  tradingAccount: Address;
  hlAccount: Address;
  allowedAssets: string[];
  agentAddress?: Address;
  agentExpiryWarnMs: number;
  sizeToleranceBps?: number;
  kill?: (reason: string) => Promise<CloseResult>;
  log?: Logger;
  now?: () => number;
}

export class Monitor {
  private readonly log: Logger;
  private lastCodes = new Set<string>();
  constructor(private readonly d: MonitorDeps) {
    this.log = d.log ?? new Logger("monitor");
  }

  async run(): Promise<Finding[]> {
    const { chain, hl } = this.d;
    const [vault, gov, universe, state, orders, agents] = await Promise.all([
      chain.vault(),
      chain.governance(),
      hl.meta(),
      hl.clearinghouseState(this.d.tradingAccount),
      hl.frontendOpenOrders(this.d.tradingAccount),
      hl.extraAgents(this.d.hlAccount),
    ]);
    const findings = checkInvariants({
      vault,
      gov,
      state,
      orders,
      agents,
      universe,
      allowedAssets: this.d.allowedAssets,
      agentAddress: this.d.agentAddress,
      agentExpiryWarnMs: this.d.agentExpiryWarnMs,
      sizeToleranceBps: this.d.sizeToleranceBps ?? 500,
      now: (this.d.now ?? (() => Date.now()))(),
    });
    const codes = new Set(findings.map((x) => `${x.level}:${x.code}`));
    for (const x of findings) {
      const key = `${x.level}:${x.code}`;
      if (this.lastCodes.has(key)) continue; // alert once per continuous condition
      await this.d.alerts.emit(x.level === "red" ? "critical" : "warning", `monitor ${x.code}`, { detail: x.detail });
    }
    for (const key of this.lastCodes) if (!codes.has(key)) this.log.info(`cleared ${key}`);
    this.lastCodes = codes;
    if (findings.length === 0) this.log.info(`ok: equity ${state.accountValue} positions ${state.positions.length} orders ${orders.length}`);
    const red = findings.filter((x) => x.level === "red");
    if (red.length > 0 && this.d.kill) {
      const r = await this.d.kill(red.map((x) => x.code).join(","));
      this.log.error(`kill switch executed, flat=${r.flat}`);
    }
    return findings;
  }
}

export { decimalToUsd6 };
