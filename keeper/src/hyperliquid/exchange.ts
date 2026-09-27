/**
 * Hyperliquid `/exchange` client restricted to trading actions. Wire formats follow the Python SDK (key order
 * matters for the msgpack action hash). Every request is signed through {@link L1Signer}, which enforces the
 * allowlist; this class simply cannot express a withdrawal.
 */
import type { Address, Hex } from "viem";
import { postJson } from "./info.js";
import type { Packable } from "./msgpack.js";
import type { L1Action, L1Signer } from "./signer.js";

export type Tif = "Alo" | "Ioc" | "Gtc";
export type Grouping = "na" | "normalTpsl" | "positionTpsl";

export interface OrderSpec {
  asset: number;
  isBuy: boolean;
  /** Decimal strings already rounded to the tick/lot rules. */
  limitPx: string;
  size: string;
  reduceOnly: boolean;
  type: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  /** 16-byte client order id, `0x` + 32 hex chars. */
  cloid?: Hex;
}

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
  c?: Hex;
}

export type OrderStatusWire =
  | { resting: { oid: number; cloid?: Hex } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: Hex } }
  | { error: string }
  | "success"
  | "waitingForFill"
  | "waitingForTrigger";

export interface ExchangeResponse {
  status: "ok" | "err";
  response?: { type: string; data?: { statuses: OrderStatusWire[] } } | string;
}

export class ExchangeError extends Error {
  constructor(readonly action: string, readonly response: unknown) {
    super(`Hyperliquid ${action} failed: ${typeof response === "string" ? response : JSON.stringify(response)}`);
  }
}

export function orderToWire(o: OrderSpec): OrderWire {
  const w: OrderWire = { a: o.asset, b: o.isBuy, p: o.limitPx, s: o.size, r: o.reduceOnly, t: o.type };
  if (o.cloid) w.c = o.cloid;
  return w;
}

/** Actions exactly as the Python SDK builds them (field order preserved). */
export const wire = {
  order: (orders: OrderSpec[], grouping: Grouping = "na"): L1Action => ({ type: "order", orders: orders.map(orderToWire) as unknown as Packable, grouping }),
  cancel: (cancels: { asset: number; oid: number }[]): L1Action => ({ type: "cancel", cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) }),
  cancelByCloid: (cancels: { asset: number; cloid: Hex }[]): L1Action => ({ type: "cancelByCloid", cancels: cancels.map((c) => ({ asset: c.asset, cloid: c.cloid })) }),
  modify: (oid: number | Hex, order: OrderSpec): L1Action => ({ type: "modify", oid, order: orderToWire(order) as unknown as Packable }),
  batchModify: (modifies: { oid: number | Hex; order: OrderSpec }[]): L1Action => ({
    type: "batchModify",
    modifies: modifies.map((m) => ({ oid: m.oid, order: orderToWire(m.order) })) as unknown as Packable,
  }),
  updateLeverage: (asset: number, isCross: boolean, leverage: number): L1Action => ({ type: "updateLeverage", asset, isCross, leverage }),
  /** `ntli` in USDC × 1e6 (signed: negative removes margin). */
  updateIsolatedMargin: (asset: number, ntli: number): L1Action => ({ type: "updateIsolatedMargin", asset, isBuy: true, ntli }),
  /** `time` undefined = unset the scheduled cancel. */
  scheduleCancel: (time?: number): L1Action => (time === undefined ? { type: "scheduleCancel" } : { type: "scheduleCancel", time }),
};

export interface HyperliquidExchange {
  readonly agentAddress: Address;
  placeOrders(orders: OrderSpec[], grouping?: Grouping): Promise<OrderStatusWire[]>;
  cancel(cancels: { asset: number; oid: number }[]): Promise<OrderStatusWire[]>;
  cancelByCloid(cancels: { asset: number; cloid: Hex }[]): Promise<OrderStatusWire[]>;
  updateLeverage(asset: number, leverage: number, isCross: boolean): Promise<void>;
  updateIsolatedMargin(asset: number, ntli: number): Promise<void>;
  scheduleCancel(time?: number): Promise<void>;
}

/** Monotonic ms nonces (Hyperliquid requires nonces within a window of now and unique per action). */
export class NonceSource {
  private last = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  next(): number {
    const n = Math.max(this.now(), this.last + 1);
    this.last = n;
    return n;
  }
}

export class HttpHyperliquidExchange implements HyperliquidExchange {
  readonly agentAddress: Address;
  constructor(
    private readonly url: string,
    private readonly signer: L1Signer,
    private readonly opts: { vaultAddress?: Address; actionTtlMs: number; now?: () => number; fetchFn?: typeof fetch; nonces?: NonceSource } ,
  ) {
    this.agentAddress = signer.address;
  }

  private async send(action: L1Action): Promise<ExchangeResponse> {
    const now = this.opts.now ?? (() => Date.now());
    const nonces = (this.opts.nonces ??= new NonceSource(now));
    const nonce = nonces.next();
    const expiresAfter = now() + this.opts.actionTtlMs;
    const signature = await this.signer.sign(action, nonce, { vaultAddress: this.opts.vaultAddress, expiresAfter });
    const payload: Record<string, unknown> = { action, nonce, signature, expiresAfter };
    if (this.opts.vaultAddress) payload.vaultAddress = this.opts.vaultAddress;
    const res = await postJson<ExchangeResponse>(this.opts.fetchFn ?? fetch, this.url, payload);
    if (res.status !== "ok") throw new ExchangeError(action.type, res.response ?? res);
    return res;
  }

  private statuses(res: ExchangeResponse, action: string): OrderStatusWire[] {
    const r = res.response;
    if (!r || typeof r === "string" || !r.data) throw new ExchangeError(action, res);
    return r.data.statuses;
  }

  async placeOrders(orders: OrderSpec[], grouping: Grouping = "na") {
    return this.statuses(await this.send(wire.order(orders, grouping)), "order");
  }
  async cancel(cancels: { asset: number; oid: number }[]) {
    if (cancels.length === 0) return [];
    return this.statuses(await this.send(wire.cancel(cancels)), "cancel");
  }
  async cancelByCloid(cancels: { asset: number; cloid: Hex }[]) {
    if (cancels.length === 0) return [];
    return this.statuses(await this.send(wire.cancelByCloid(cancels)), "cancelByCloid");
  }
  async updateLeverage(asset: number, leverage: number, isCross: boolean) {
    await this.send(wire.updateLeverage(asset, isCross, leverage));
  }
  async updateIsolatedMargin(asset: number, ntli: number) {
    await this.send(wire.updateIsolatedMargin(asset, ntli));
  }
  async scheduleCancel(time?: number) {
    await this.send(wire.scheduleCancel(time));
  }
}

/** Order-level error extracted from a status entry, if any. */
export const statusError = (s: OrderStatusWire | undefined): string | undefined => (typeof s === "object" && s !== null && "error" in s ? s.error : undefined);
export const statusFilled = (s: OrderStatusWire | undefined) => (typeof s === "object" && s !== null && "filled" in s ? s.filled : undefined);
export const statusResting = (s: OrderStatusWire | undefined) => (typeof s === "object" && s !== null && "resting" in s ? s.resting : undefined);
