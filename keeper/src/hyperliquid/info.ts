import type { Address, Hex } from "viem";
import type { HlAccountState, HlAgent, HlOpenOrder, HlOrderStatus, PerpMeta } from "../types.js";

/** Read-only Hyperliquid `/info` access. Mockable in tests. */
export interface HyperliquidInfo {
  meta(): Promise<PerpMeta[]>;
  allMids(): Promise<Record<string, string>>;
  clearinghouseState(user: Address): Promise<HlAccountState>;
  frontendOpenOrders(user: Address): Promise<HlOpenOrder[]>;
  extraAgents(user: Address): Promise<HlAgent[]>;
  orderStatus(user: Address, oid: number | Hex): Promise<HlOrderStatus>;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export async function postJson<T>(fetchFn: typeof fetch, url: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text);
  return JSON.parse(text) as T;
}

export class HttpHyperliquidInfo implements HyperliquidInfo {
  private metaCache?: { at: number; value: PerpMeta[] };

  constructor(
    readonly url: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly metaTtlMs = 10 * 60_000,
  ) {}

  private post<T>(body: Record<string, unknown>): Promise<T> {
    return postJson<T>(this.fetchFn, this.url, body);
  }

  async meta(): Promise<PerpMeta[]> {
    if (this.metaCache && Date.now() - this.metaCache.at < this.metaTtlMs) return this.metaCache.value;
    const m = await this.post<{ universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] }>({ type: "meta" });
    const value = m.universe.map((u, index) => ({
      index,
      name: u.name,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      isDelisted: u.isDelisted === true,
    }));
    this.metaCache = { at: Date.now(), value };
    return value;
  }

  allMids(): Promise<Record<string, string>> {
    return this.post({ type: "allMids" });
  }

  async clearinghouseState(user: Address): Promise<HlAccountState> {
    const s = await this.post<{
      marginSummary: { accountValue: string; totalMarginUsed: string };
      withdrawable: string;
      assetPositions: {
        position: {
          coin: string;
          szi: string;
          leverage: { type: "cross" | "isolated"; value: number };
          entryPx?: string | null;
          positionValue: string;
          unrealizedPnl: string;
          liquidationPx?: string | null;
          marginUsed: string;
        };
      }[];
    }>({ type: "clearinghouseState", user });
    return {
      accountValue: s.marginSummary.accountValue,
      totalMarginUsed: s.marginSummary.totalMarginUsed,
      withdrawable: s.withdrawable,
      positions: s.assetPositions.map((p) => ({
        coin: p.position.coin,
        szi: p.position.szi,
        leverageType: p.position.leverage.type,
        leverage: p.position.leverage.value,
        entryPx: p.position.entryPx ?? undefined,
        positionValue: p.position.positionValue,
        unrealizedPnl: p.position.unrealizedPnl,
        liquidationPx: p.position.liquidationPx ?? undefined,
        marginUsed: p.position.marginUsed,
      })),
    };
  }

  frontendOpenOrders(user: Address): Promise<HlOpenOrder[]> {
    return this.post({ type: "frontendOpenOrders", user });
  }

  extraAgents(user: Address): Promise<HlAgent[]> {
    return this.post({ type: "extraAgents", user });
  }

  async orderStatus(user: Address, oid: number | Hex): Promise<HlOrderStatus> {
    const r = await this.post<{ status: string; order?: { order: HlOpenOrder; status: string } }>({ type: "orderStatus", user, oid });
    if (r.status !== "order" || !r.order) return { status: "unknownOid" };
    return { status: "order", state: r.order.status, order: r.order.order };
  }
}

/** Finds a perp by index, fail-closed on delisted or unknown indexes. */
export function perpByIndex(universe: PerpMeta[], index: number): PerpMeta {
  const p = universe[index];
  if (!p) throw new Error(`unknown Hyperliquid asset index ${index}`);
  if (p.isDelisted) throw new Error(`Hyperliquid asset ${p.name} (${index}) is delisted`);
  return p;
}
