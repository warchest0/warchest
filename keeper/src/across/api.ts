import { getAddress, type Address, type Hex } from "viem";
import type { AcrossDepositStatus, AcrossLimits, AcrossQuote } from "../types.js";

export interface RouteParams {
  inputToken: Address;
  outputToken: Address;
  originChainId: bigint;
  destinationChainId: bigint;
}

/** Read-only access to the public Across API (GET endpoints only). Mockable in tests. */
export interface AcrossApi {
  limits(route: RouteParams): Promise<AcrossLimits>;
  suggestedFees(route: RouteParams, amount: bigint, recipient?: Address): Promise<AcrossQuote>;
  depositStatus(originChainId: bigint, depositId: bigint): Promise<AcrossDepositStatus>;
}

export class AcrossApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Across API ${status}: ${body.slice(0, 300)}`);
  }
}

const parseLimits = (l: Record<string, string>): AcrossLimits => ({
  minDeposit: BigInt(l.minDeposit ?? "0"),
  maxDeposit: BigInt(l.maxDeposit ?? "0"),
  maxDepositInstant: BigInt(l.maxDepositInstant ?? "0"),
  maxDepositShortDelay: BigInt(l.maxDepositShortDelay ?? "0"),
  recommendedDepositInstant: BigInt(l.recommendedDepositInstant ?? "0"),
});

export class HttpAcrossApi implements AcrossApi {
  constructor(readonly baseUrl: string, private readonly fetchFn: typeof fetch = fetch) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new AcrossApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  private routeParams(r: RouteParams): Record<string, string> {
    return {
      inputToken: r.inputToken,
      outputToken: r.outputToken,
      originChainId: r.originChainId.toString(),
      destinationChainId: r.destinationChainId.toString(),
    };
  }

  async limits(route: RouteParams): Promise<AcrossLimits> {
    return parseLimits(await this.get<Record<string, string>>("/limits", this.routeParams(route)));
  }

  async suggestedFees(route: RouteParams, amount: bigint, recipient?: Address): Promise<AcrossQuote> {
    const q = await this.get<{
      outputAmount: string;
      timestamp: string;
      fillDeadline: string;
      totalRelayFee: { pct: string; total: string };
      lpFee: { pct: string; total: string };
      estimatedFillTimeSec: number;
      isAmountTooLow: boolean;
      spokePoolAddress: string;
      exclusiveRelayer: string;
      exclusivityDeadline: number;
      limits: Record<string, string>;
    }>("/suggested-fees", { ...this.routeParams(route), amount: amount.toString(), ...(recipient ? { recipient } : {}) });
    return {
      outputAmount: BigInt(q.outputAmount),
      timestamp: Number(q.timestamp),
      fillDeadline: Number(q.fillDeadline),
      totalRelayFeePct: BigInt(q.totalRelayFee.pct),
      totalRelayFeeTotal: BigInt(q.totalRelayFee.total),
      lpFeePct: BigInt(q.lpFee.pct),
      estimatedFillTimeSec: Number(q.estimatedFillTimeSec),
      isAmountTooLow: q.isAmountTooLow === true,
      spokePoolAddress: getAddress(q.spokePoolAddress),
      exclusiveRelayer: getAddress(q.exclusiveRelayer),
      exclusivityDeadline: Number(q.exclusivityDeadline),
      limits: parseLimits(q.limits),
    };
  }

  async depositStatus(originChainId: bigint, depositId: bigint): Promise<AcrossDepositStatus> {
    let raw: { status?: string; fillTx?: string; fillTxHash?: string; depositRefundTxHash?: string; fillTimestamp?: number };
    try {
      raw = await this.get("/deposit/status", { originChainId: originChainId.toString(), depositId: depositId.toString() });
    } catch (e) {
      if (e instanceof AcrossApiError && e.status === 404) return { status: "unknown", raw: e.body };
      throw e;
    }
    switch (raw.status) {
      case "filled":
        return { status: "filled", fillTxHash: (raw.fillTx ?? raw.fillTxHash) as Hex | undefined, fillTimestamp: raw.fillTimestamp };
      case "pending":
        return { status: "pending" };
      case "expired":
        return { status: "expired" };
      case "refunded":
        return { status: "refunded", refundTxHash: raw.depositRefundTxHash as Hex | undefined };
      default:
        return { status: "unknown", raw };
    }
  }
}

/** USDG on Robinhood Chain → USDC on HyperEVM (DECISIONS.md D5). */
export const USDG_ROBINHOOD = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
export const USDC_HYPEREVM = getAddress("0xb88339CB7199b77E23DB6E890353E22632Ba630f");
export const HYPEREVM_CHAIN_ID = 999n;
