/**
 * Trading engine: turns the planner's OpenPlan / ProtectPlan / ClosePlan into Hyperliquid actions through the
 * allowlisted exchange client, and verifies every effect by reading the account back (`/info`) before reporting
 * success. Fail-closed everywhere: an unverifiable protection flattens the position.
 *
 * Idempotency: every entry / protection order carries a deterministic client order id derived from
 * (decision id, purpose, attempt). Before sending, the engine asks `orderStatus(cloid)`; an order that already exists
 * is never re-sent, so a crash between "sent" and "persisted" cannot double the position.
 *
 * Dead-man switch (`scheduleCancel`): armed ONLY around the entry order and disarmed before the stop-loss is placed.
 * It cancels ALL open orders (the protective stop included), so it must never be left armed while a position is
 * protected. If the disarm fails after a fill, the fill is flattened.
 */
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import type { Alerts } from "../log.js";
import { Logger } from "../log.js";
import type { ClosePlan, OpenPlan, ProtectPlan } from "../planner.js";
import { planClose } from "../planner.js";
import type { CloseResult, OpenResult, ProtectResult } from "../executor.js";
import type { Run } from "../store.js";
import type { HlOpenOrder, HlPosition, PerpMeta } from "../types.js";
import { statusError, statusFilled, statusResting, type HyperliquidExchange, type OrderSpec } from "./exchange.js";
import type { HyperliquidInfo } from "./info.js";
import { absDecimal, cmpDecimals, mulBps, roundPrice } from "./rounding.js";

export interface EngineOptions {
  /** Account whose positions/orders are read (the traded sub-account or master). */
  tradingAccount: Address;
  /** Slippage bound for the kill switch (bps), typically 2× the entry bound. */
  killSlippageBps: number;
  /** Extra room given to a triggered market stop/TP: its limit price is trigger × (1 ∓ this), bps. */
  triggerLimitBps: number;
  /** Ms after `now` at which the dead-man switch fires if the entry is not disarmed. */
  deadManMs: number;
  /** Read-back attempts and delay when verifying the stop. */
  verifyAttempts: number;
  verifyDelayMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 16-byte client order id, deterministic per (decision, purpose, attempt). */
export function cloidFor(decisionId: bigint, purpose: string, attempt: number | string): Hex {
  return `0x${keccak256(stringToHex(`warchest:${decisionId}:${purpose}:${attempt}`)).slice(2, 34)}` as Hex;
}

export class TradingEngine {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly exchange: HyperliquidExchange,
    private readonly info: HyperliquidInfo,
    private readonly alerts: Alerts,
    private readonly opts: EngineOptions,
    log?: Logger,
  ) {
    this.log = log ?? new Logger("engine");
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async position(coin: string): Promise<HlPosition | undefined> {
    const s = await this.info.clearinghouseState(this.opts.tradingAccount);
    return s.positions.find((p) => p.coin === coin);
  }

  private async perp(coin: string): Promise<PerpMeta> {
    const p = (await this.info.meta()).find((m) => m.name === coin);
    if (!p) throw new Error(`unknown coin ${coin}`);
    return p;
  }

  // ---------------------------------------------------------------------------------------------------------------

  async open(plan: OpenPlan, run: Run): Promise<OpenResult> {
    const attempt = (run.data.entryAttempts ?? 0) + 1;
    const cloid = cloidFor(plan.decisionId, "entry", attempt);
    const prior = await this.info.orderStatus(this.opts.tradingAccount, cloid);
    if (prior.status === "order") {
      // already sent before a crash: never re-send, report what the account shows
      const pos = await this.position(plan.coin);
      this.log.warn(`entry ${cloid} already exists (${prior.state}); not re-sending`);
      return { done: true, attempts: attempt, oids: [prior.order.oid], filledSize: pos ? absDecimal(pos.szi) : "0", avgPx: pos?.entryPx, note: "entry already existed" };
    }

    await this.exchange.updateLeverage(plan.asset, plan.leverage, false);
    const armed = await this.arm();
    const order: OrderSpec = { asset: plan.asset, isBuy: plan.isBuy, limitPx: plan.limitPx, size: plan.size, reduceOnly: false, type: { limit: { tif: "Ioc" } }, cloid };
    let statuses;
    try {
      statuses = await this.exchange.placeOrders([order], "na");
    } finally {
      if (armed && !(await this.disarm())) {
        await this.alerts.critical("dead-man switch could not be disarmed after the entry: flattening", { decisionId: plan.decisionId });
        await this.flattenCoin(plan.coin, "dead-man switch stuck");
        return { done: true, attempts: attempt, oids: [], filledSize: "0", note: "disarm failed, flattened" };
      }
    }
    const st = statuses[0];
    const err = statusError(st);
    if (err) {
      this.log.warn(`entry rejected: ${err}`);
      return { done: true, attempts: attempt, oids: [], filledSize: "0", note: err };
    }
    const resting = statusResting(st);
    if (resting) {
      // an IOC never rests; be safe anyway
      await this.exchange.cancel([{ asset: plan.asset, oid: resting.oid }]);
    }
    const filled = statusFilled(st);
    const pos = await this.position(plan.coin);
    const filledSize = pos ? absDecimal(pos.szi) : (filled?.totalSz ?? "0");
    if (pos && (pos.leverageType !== "isolated" || pos.leverage !== plan.leverage)) {
      await this.alerts.critical("position margin mode / leverage differs from the vault parameters: flattening", { coin: plan.coin, mode: pos.leverageType, leverage: pos.leverage, expected: plan.leverage });
      await this.flattenCoin(plan.coin, "leverage mismatch");
      return { done: true, attempts: attempt, oids: filled ? [filled.oid] : [], filledSize: "0", note: "leverage mismatch, flattened" };
    }
    this.log.info(`entry attempt ${attempt}: filled ${filledSize} @ ${filled?.avgPx ?? pos?.entryPx ?? "?"}`);
    return { done: true, attempts: attempt, oids: filled ? [filled.oid] : resting ? [resting.oid] : [], filledSize, avgPx: filled?.avgPx ?? pos?.entryPx };
  }

  // ---------------------------------------------------------------------------------------------------------------

  async protect(plan: ProtectPlan, run: Run): Promise<ProtectResult> {
    const attempt = (run.data.protectAttempts ?? 0) + 1;
    const isLong = plan.side === "long";
    const slCloid = cloidFor(plan.decisionId, "sl", attempt);
    const tpCloid = cloidFor(plan.decisionId, "tp", attempt);
    const specs: OrderSpec[] = [];
    let slOid: number | undefined;
    let tpOid: number | undefined;

    const existing = async (cloid: Hex) => {
      const s = await this.info.orderStatus(this.opts.tradingAccount, cloid);
      return s.status === "order" && s.state === "open" ? s.order.oid : undefined;
    };
    slOid = await existing(slCloid);
    if (slOid === undefined) {
      specs.push({
        asset: plan.asset,
        isBuy: !isLong,
        limitPx: roundPrice(mulBps(plan.stopLossPx, isLong ? 10_000 - this.opts.triggerLimitBps : 10_000 + this.opts.triggerLimitBps), plan.szDecimals, isLong ? "down" : "up"),
        size: plan.size,
        reduceOnly: true,
        type: { trigger: { isMarket: true, triggerPx: plan.stopLossPx, tpsl: "sl" } },
        cloid: slCloid,
      });
    }
    if (plan.takeProfitPx) {
      tpOid = await existing(tpCloid);
      if (tpOid === undefined) {
        specs.push({
          asset: plan.asset,
          isBuy: !isLong,
          limitPx: roundPrice(mulBps(plan.takeProfitPx, isLong ? 10_000 - this.opts.triggerLimitBps : 10_000 + this.opts.triggerLimitBps), plan.szDecimals, isLong ? "down" : "up"),
          size: plan.size,
          reduceOnly: true,
          type: { trigger: { isMarket: true, triggerPx: plan.takeProfitPx, tpsl: "tp" } },
          cloid: tpCloid,
        });
      }
    }
    if (specs.length > 0) {
      const statuses = await this.exchange.placeOrders(specs, "positionTpsl");
      specs.forEach((spec, i) => {
        const st = statuses[i];
        const err = statusError(st);
        const oid = statusResting(st)?.oid;
        if (err) this.log.warn(`${spec.cloid === slCloid ? "stop" : "take-profit"} rejected: ${err}`);
        if (spec.cloid === slCloid) slOid = oid;
        else tpOid = oid;
      });
    }

    // read-back: the stop must be visible as a reduce-only trigger on the right side, price and size
    let verified = false;
    for (let i = 0; i < this.opts.verifyAttempts && !verified; i++) {
      if (i > 0) await this.sleep(this.opts.verifyDelayMs);
      const orders = await this.info.frontendOpenOrders(this.opts.tradingAccount);
      verified = orders.some((o) => isStopFor(o, plan, slCloid, slOid));
    }
    if (!verified) this.log.error("stop-loss not found in open orders after placement", { slCloid, slOid });
    return { done: true, verified, stopLossOid: slOid, takeProfitOid: tpOid, attempts: attempt };
  }

  // ---------------------------------------------------------------------------------------------------------------

  async close(plan: ClosePlan, run: Run): Promise<CloseResult> {
    await this.cancelCoin(plan.coin, plan.asset);
    const cloid = cloidFor(run.decisionId, "close", this.now());
    const statuses = await this.exchange.placeOrders([{ asset: plan.asset, isBuy: plan.isBuy, limitPx: plan.limitPx, size: plan.size, reduceOnly: true, type: { limit: { tif: "Ioc" } }, cloid }], "na");
    const err = statusError(statuses[0]);
    if (err) this.log.warn(`close order rejected: ${err}`);
    const pos = await this.position(plan.coin);
    const flat = !pos || cmpDecimals(absDecimal(pos.szi), "0") === 0;
    this.log.info(`close ${plan.coin} (${plan.reason}): ${flat ? "flat" : `remaining ${pos?.szi}`}`);
    return { done: true, flat, note: err };
  }

  /** Cancel every order and flatten every position on the account, whatever the coin. */
  async killSwitch(reason: string): Promise<CloseResult> {
    await this.alerts.critical("KILL SWITCH", { reason });
    const orders = await this.info.frontendOpenOrders(this.opts.tradingAccount);
    const universe = await this.info.meta();
    const byName = new Map(universe.map((p) => [p.name, p]));
    const cancels = orders.flatMap((o) => (byName.has(o.coin) ? [{ asset: byName.get(o.coin)!.index, oid: o.oid }] : []));
    if (cancels.length > 0) await this.exchange.cancel(cancels);
    const state = await this.info.clearinghouseState(this.opts.tradingAccount);
    const mids = await this.info.allMids();
    for (const pos of state.positions) {
      const perp = byName.get(pos.coin);
      if (!perp) continue;
      const plan = planClose(perp, pos, mids[pos.coin] ?? "0", this.opts.killSlippageBps, reason);
      if (plan.kind === "refused") {
        this.log.error(`kill: cannot plan close for ${pos.coin}: ${plan.reason}`);
        continue;
      }
      const st = await this.exchange.placeOrders([{ asset: perp.index, isBuy: plan.isBuy, limitPx: plan.limitPx, size: plan.size, reduceOnly: true, type: { limit: { tif: "Ioc" } }, cloid: cloidFor(0n, "kill", this.now()) }], "na");
      const err = statusError(st[0]);
      if (err) this.log.error(`kill: close ${pos.coin} rejected: ${err}`);
    }
    const after = await this.info.clearinghouseState(this.opts.tradingAccount);
    const flat = after.positions.every((p) => cmpDecimals(absDecimal(p.szi), "0") === 0);
    if (!flat) await this.alerts.critical("kill switch: positions remain", { coins: after.positions.map((p) => `${p.coin}:${p.szi}`) });
    return { done: true, flat };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async cancelCoin(coin: string, asset: number): Promise<void> {
    const orders = await this.info.frontendOpenOrders(this.opts.tradingAccount);
    const mine = orders.filter((o) => o.coin === coin).map((o) => ({ asset, oid: o.oid }));
    if (mine.length > 0) await this.exchange.cancel(mine);
  }

  private async flattenCoin(coin: string, reason: string): Promise<void> {
    const pos = await this.position(coin);
    if (!pos) return;
    const perp = await this.perp(coin);
    const mids = await this.info.allMids();
    const plan = planClose(perp, pos, mids[coin] ?? "0", this.opts.killSlippageBps, reason);
    if (plan.kind === "refused") {
      await this.alerts.critical("cannot flatten", { coin, reason: plan.reason });
      return;
    }
    await this.cancelCoin(coin, perp.index);
    await this.exchange.placeOrders([{ asset: perp.index, isBuy: plan.isBuy, limitPx: plan.limitPx, size: plan.size, reduceOnly: true, type: { limit: { tif: "Ioc" } }, cloid: cloidFor(0n, "flatten", this.now()) }], "na");
  }

  /** Best effort: some accounts are not allowed to schedule cancels (volume requirement). */
  private async arm(): Promise<boolean> {
    try {
      await this.exchange.scheduleCancel(this.now() + this.opts.deadManMs);
      return true;
    } catch (e) {
      this.log.warn("scheduleCancel (dead-man switch) unavailable", { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  private async disarm(): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      try {
        await this.exchange.scheduleCancel(undefined);
        return true;
      } catch (e) {
        this.log.error("scheduleCancel disarm failed", { error: e instanceof Error ? e.message : String(e) });
        await this.sleep(this.opts.verifyDelayMs);
      }
    }
    return false;
  }
}

/** Whether `o` is the protective stop mandated by `plan`. */
export function isStopFor(o: HlOpenOrder, plan: Pick<ProtectPlan, "coin" | "side" | "stopLossPx" | "size">, cloid?: Hex, oid?: number): boolean {
  if (o.coin !== plan.coin || !o.isTrigger || !o.reduceOnly) return false;
  if (!o.orderType.toLowerCase().includes("stop")) return false;
  if (cloid && o.cloid && o.cloid.toLowerCase() !== cloid.toLowerCase() && (oid === undefined || o.oid !== oid)) return false;
  const expectedSide = plan.side === "long" ? "A" : "B";
  if (o.side !== expectedSide) return false;
  if (cmpDecimals(o.triggerPx, plan.stopLossPx) !== 0) return false;
  return o.isPositionTpsl || cmpDecimals(o.sz, plan.size) >= 0;
}
