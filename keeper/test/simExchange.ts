import type { Hex } from "viem";
import type { Grouping, HyperliquidExchange, OrderSpec, OrderStatusWire } from "../src/hyperliquid/exchange.js";
import type { HlOpenOrder } from "../src/types.js";
import { KEEPER, UNIVERSE, type FakeHl } from "./fakes.js";

/**
 * Tiny Hyperliquid simulator behind the `HyperliquidExchange` interface. It mutates a `FakeHl` so that the engine's
 * read-backs (`clearinghouseState`, `frontendOpenOrders`, `orderStatus`) observe what was "executed".
 * Numbers are plain floats: this is test scaffolding, not accounting.
 */
export class SimExchange implements HyperliquidExchange {
  readonly agentAddress = KEEPER;
  leverage = new Map<number, { isCross: boolean; leverage: number }>();
  /** Last scheduled cancel time; null = disarmed; undefined = never touched. */
  scheduled: number | null | undefined = undefined;
  scheduleArmRejects = false;
  scheduleDisarmRejects = false;
  /** Fraction (bps) of an IOC size that fills. */
  fillRatioBps = 10_000;
  rejectTriggers = false;
  rejectEntry?: string;
  /** Simulate triggers accepted by the API but invisible in `frontendOpenOrders`. */
  hideTriggersFromReadback = false;
  /** Force every position into cross margin (leverage mismatch scenario). */
  forceCross = false;
  nextOid = 100;
  log: { action: string; args: unknown }[] = [];

  constructor(readonly hl: FakeHl) {}

  private perp(asset: number) {
    const p = UNIVERSE[asset];
    if (!p) throw new Error(`sim: unknown asset ${asset}`);
    return p;
  }

  private applyFill(asset: number, isBuy: boolean, size: number, px: number, reduceOnly: boolean): number {
    const perp = this.perp(asset);
    const positions = this.hl.state.positions;
    const idx = positions.findIndex((p) => p.coin === perp.name);
    const cur = idx >= 0 ? Number(positions[idx]!.szi) : 0;
    let fill = size;
    if (reduceOnly) {
      const closable = isBuy ? Math.max(0, -cur) : Math.max(0, cur);
      fill = Math.min(fill, closable);
    }
    if (fill === 0) return 0;
    const next = Number((cur + (isBuy ? fill : -fill)).toFixed(perp.szDecimals));
    const lev = this.leverage.get(asset) ?? { isCross: true, leverage: 20 };
    if (next === 0) {
      if (idx >= 0) positions.splice(idx, 1);
    } else {
      const pos = {
        coin: perp.name,
        szi: String(next),
        leverageType: this.forceCross || lev.isCross ? ("cross" as const) : ("isolated" as const),
        leverage: lev.leverage,
        entryPx: String(px),
        positionValue: (Math.abs(next) * px).toFixed(2),
        unrealizedPnl: "0",
        marginUsed: ((Math.abs(next) * px) / lev.leverage).toFixed(2),
      };
      if (idx >= 0) positions[idx] = pos;
      else positions.push(pos);
    }
    return fill;
  }

  async placeOrders(orders: OrderSpec[], grouping: Grouping = "na"): Promise<OrderStatusWire[]> {
    this.log.push({ action: "order", args: { orders, grouping } });
    return orders.map((o) => {
      const perp = this.perp(o.asset);
      const oid = this.nextOid++;
      if ("trigger" in o.type) {
        if (this.rejectTriggers) return { error: "sim: trigger rejected" };
        const order: HlOpenOrder = {
          coin: perp.name,
          side: o.isBuy ? "B" : "A",
          limitPx: o.limitPx,
          sz: o.size,
          origSz: o.size,
          oid,
          timestamp: 0,
          isTrigger: true,
          triggerPx: o.type.trigger.triggerPx,
          triggerCondition: `${o.type.trigger.tpsl === "sl" ? "Price below" : "Price above"} ${o.type.trigger.triggerPx}`,
          isPositionTpsl: grouping === "positionTpsl",
          reduceOnly: o.reduceOnly,
          orderType: o.type.trigger.tpsl === "sl" ? "Stop Market" : "Take Profit Market",
          tif: null,
          cloid: o.cloid ?? null,
        };
        if (!this.hideTriggersFromReadback) this.hl.orders.push(order);
        if (o.cloid) this.hl.statuses.set(o.cloid, { status: "order", state: "open", order });
        return { resting: { oid, cloid: o.cloid } };
      }
      if (this.rejectEntry && !o.reduceOnly) return { error: this.rejectEntry };
      const want = Number(o.size) * (this.fillRatioBps / 10_000);
      const fill = this.applyFill(o.asset, o.isBuy, Number(want.toFixed(perp.szDecimals)), Number(o.limitPx), o.reduceOnly);
      const order: HlOpenOrder = { coin: perp.name, side: o.isBuy ? "B" : "A", limitPx: o.limitPx, sz: "0", origSz: o.size, oid, timestamp: 0, isTrigger: false, triggerPx: "0", triggerCondition: "N/A", isPositionTpsl: false, reduceOnly: o.reduceOnly, orderType: "Limit", tif: "Ioc", cloid: o.cloid ?? null };
      if (o.cloid) this.hl.statuses.set(o.cloid, { status: "order", state: fill > 0 ? "filled" : "canceled", order });
      if (fill === 0) return { error: "Order could not immediately match against any resting orders." };
      return { filled: { totalSz: String(fill), avgPx: o.limitPx, oid, cloid: o.cloid } };
    });
  }

  async cancel(cancels: { asset: number; oid: number }[]): Promise<OrderStatusWire[]> {
    this.log.push({ action: "cancel", args: cancels });
    for (const c of cancels) {
      const i = this.hl.orders.findIndex((o) => o.oid === c.oid);
      if (i >= 0) {
        const [o] = this.hl.orders.splice(i, 1);
        if (o?.cloid) this.hl.statuses.set(o.cloid, { status: "order", state: "canceled", order: o });
      }
    }
    return cancels.map(() => "success" as const);
  }

  async cancelByCloid(cancels: { asset: number; cloid: Hex }[]): Promise<OrderStatusWire[]> {
    this.log.push({ action: "cancelByCloid", args: cancels });
    for (const c of cancels) {
      const i = this.hl.orders.findIndex((o) => o.cloid === c.cloid);
      if (i >= 0) this.hl.orders.splice(i, 1);
    }
    return cancels.map(() => "success" as const);
  }

  async updateLeverage(asset: number, leverage: number, isCross: boolean): Promise<void> {
    this.log.push({ action: "updateLeverage", args: { asset, leverage, isCross } });
    this.leverage.set(asset, { isCross, leverage });
  }

  async updateIsolatedMargin(asset: number, ntli: number): Promise<void> {
    this.log.push({ action: "updateIsolatedMargin", args: { asset, ntli } });
  }

  async scheduleCancel(time?: number): Promise<void> {
    this.log.push({ action: "scheduleCancel", args: time });
    if (time === undefined) {
      if (this.scheduleDisarmRejects) throw new Error("sim: disarm rejected");
      this.scheduled = null;
    } else {
      if (this.scheduleArmRejects) throw new Error("sim: Scheduled cancel is only available to users with sufficient volume");
      this.scheduled = time;
    }
  }

  actions(): string[] {
    return this.log.map((l) => l.action);
  }
}
