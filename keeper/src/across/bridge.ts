/**
 * Bridge module (S5.3): the outbound leg is executed by the vault itself (`executeDecision`, recipient immutable);
 * this module quotes it, tracks the Across deposit and PLANS the return leg for the Hyperliquid multisig. The keeper
 * never signs a return: it produces a payload the signers can check line by line.
 */
import type { Address } from "viem";
import type { VaultSnapshot, AcrossDepositStatus, AcrossLimits, AcrossQuote } from "../types.js";
import type { AcrossApi, RouteParams } from "./api.js";
import { HYPEREVM_CHAIN_ID, USDC_HYPEREVM, USDG_ROBINHOOD } from "./api.js";
import { DEPOSIT_QUOTE_TIME_BUFFER, FILL_DEADLINE_BUFFER } from "../planner.js";

/** HyperCore ↔ HyperEVM system address of USDC (token index 0). */
export const HYPERCORE_USDC_SYSTEM_ADDRESS: Address = "0x2000000000000000000000000000000000000000";
/** Arbitrum bridge address used by `withdraw3` (alternative return path B, RESEARCH.md §2.4/§3.1). */
export const ARBITRUM_CHAIN_ID = 42161n;

export const outboundRoute = (vault: Pick<VaultSnapshot, "usdg" | "bridgeOutputToken" | "destinationChainId">, originChainId: bigint): RouteParams => ({
  inputToken: vault.usdg,
  outputToken: vault.bridgeOutputToken,
  originChainId,
  destinationChainId: vault.destinationChainId,
});

export const returnRoute = (vault: Pick<VaultSnapshot, "usdg" | "bridgeOutputToken" | "destinationChainId">, originChainId: bigint): RouteParams => ({
  inputToken: vault.bridgeOutputToken,
  outputToken: vault.usdg,
  originChainId: vault.destinationChainId,
  destinationChainId: originChainId,
});

export const DEFAULT_RETURN_ROUTE: RouteParams = { inputToken: USDC_HYPEREVM, outputToken: USDG_ROBINHOOD, originChainId: HYPEREVM_CHAIN_ID, destinationChainId: 4663n };

// -------------------------------------------------------------------------------------------------------------------
// Outbound deposit tracking
// -------------------------------------------------------------------------------------------------------------------

export type DepositResolution =
  | { state: "pending"; reason: string }
  | { state: "filled" }
  | { state: "refunded"; reason: string }
  | { state: "expired"; reason: string };

/**
 * Combines the Across API status with what the vault shows: a refund of an expired deposit lands on the vault as
 * stray USDG (`balance − ledger`), whether or not the API has caught up. `fillDeadline` comes from the quote used.
 */
export function classifyDeposit(api: AcrossDepositStatus, vault: Pick<VaultSnapshot, "usdgBalance" | "usdgLedger" | "blockTimestamp">, capital: bigint, fillDeadline?: number): DepositResolution {
  const stray = vault.usdgBalance - vault.usdgLedger;
  if (api.status === "filled") return { state: "filled" };
  if (api.status === "refunded") return { state: "refunded", reason: "Across reports the refund" };
  if (stray >= capital && capital > 0n) return { state: "refunded", reason: `${stray} USDG back on the vault (≥ capital)` };
  if (api.status === "expired") return { state: "expired", reason: "Across reports expiry; the SpokePool refunds the depositor (the vault) in a later bundle" };
  if (fillDeadline !== undefined && vault.blockTimestamp > fillDeadline + 900) {
    return { state: "expired", reason: `fill deadline ${fillDeadline} passed without a fill; waiting for the refund` };
  }
  return { state: "pending", reason: api.status === "unknown" ? "deposit not indexed by Across yet" : "waiting for a relayer" };
}

// -------------------------------------------------------------------------------------------------------------------
// Return leg (multisig)
// -------------------------------------------------------------------------------------------------------------------

export interface ReturnChunk {
  index: number;
  inputAmount: bigint;
  /** From a live `/suggested-fees` quote when available. Signers must re-quote at signing time. */
  outputAmount?: bigint;
  quoteTimestamp?: number;
  fillDeadline?: number;
  feeBps?: number;
  estimatedFillTimeSec?: number;
}

export interface ReturnPlan {
  decisionId: bigint;
  /** USDC (6 decimals) to bring back, in perp margin on HyperCore. */
  total: bigint;
  chunks: ReturnChunk[];
  limits: AcrossLimits;
  route: RouteParams;
  /** Recipient of the Across return: the vault (finalizeClose measures balance − ledger). */
  recipient: Address;
  steps: string[];
  /** Alternative path through Arbitrum (withdraw3 → CCTP/Across) for the signers to consider. */
  alternative: string[];
  warnings: string[];
}

/** Splits `total` into Across deposits within [minDeposit, maxDepositInstant] (or maxDeposit when instant is 0). */
export function splitReturn(total: bigint, limits: AcrossLimits): { chunks: bigint[]; warnings: string[] } {
  const warnings: string[] = [];
  const cap = limits.maxDepositInstant > 0n ? limits.maxDepositInstant : limits.maxDeposit;
  if (total <= 0n) return { chunks: [], warnings: ["nothing to return"] };
  if (cap <= 0n) return { chunks: [total], warnings: ["Across reports no capacity on the return route: re-check /limits before signing"] };
  if (limits.maxDeposit > 0n && cap > limits.maxDeposit) warnings.push("maxDepositInstant > maxDeposit in /limits: using maxDepositInstant");
  const chunks: bigint[] = [];
  let left = total;
  while (left > 0n) {
    const c = left > cap ? cap : left;
    chunks.push(c);
    left -= c;
  }
  // the last chunk must clear minDeposit: merge it into the previous one when possible
  const last = chunks[chunks.length - 1]!;
  if (chunks.length > 1 && last < limits.minDeposit) {
    chunks.pop();
    chunks[chunks.length - 1]! += last;
    if (chunks[chunks.length - 1]! > cap) warnings.push(`last chunk ${chunks[chunks.length - 1]} exceeds the instant limit ${cap} (slower fill)`);
  } else if (chunks.length === 1 && last < limits.minDeposit) {
    warnings.push(`amount ${last} is below Across minDeposit ${limits.minDeposit}: dust stays on Hyperliquid`);
    return { chunks: [], warnings };
  }
  if (chunks.length > 1) warnings.push(`${chunks.length} deposits needed (limit ${cap} per transfer)`);
  return { chunks, warnings };
}

export async function planReturn(
  across: AcrossApi,
  decisionId: bigint,
  total: bigint,
  vault: Pick<VaultSnapshot, "usdg" | "bridgeOutputToken" | "destinationChainId" | "bridgeRecipient">,
  vaultAddress: Address,
  originChainId: bigint,
  opts: { tradingAccount: Address; quote?: boolean } ,
): Promise<ReturnPlan> {
  const route = returnRoute(vault, originChainId);
  const limits = await across.limits(route);
  const { chunks, warnings } = splitReturn(total, limits);
  const out: ReturnChunk[] = [];
  for (const [i, inputAmount] of chunks.entries()) {
    const chunk: ReturnChunk = { index: i + 1, inputAmount };
    if (opts.quote !== false) {
      try {
        const q: AcrossQuote = await across.suggestedFees(route, inputAmount, vaultAddress);
        chunk.outputAmount = q.outputAmount;
        chunk.quoteTimestamp = q.timestamp;
        chunk.fillDeadline = q.fillDeadline;
        chunk.feeBps = Number(((inputAmount - q.outputAmount) * 10_000n) / inputAmount);
        chunk.estimatedFillTimeSec = q.estimatedFillTimeSec;
      } catch (e) {
        warnings.push(`quote failed for chunk ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.push(chunk);
  }
  const usd = (x: bigint) => `${(Number(x) / 1e6).toFixed(2)} USDC`;
  const sub = opts.tradingAccount.toLowerCase() !== vault.bridgeRecipient.toLowerCase();
  const steps = [
    ...(sub ? [`1. HyperCore: subAccountTransfer ${usd(total)} from ${opts.tradingAccount} to the master ${vault.bridgeRecipient} (multisig)`] : []),
    `${sub ? 2 : 1}. HyperCore: usdClassTransfer ${usd(total)} perp → spot on ${vault.bridgeRecipient} (multisig)`,
    `${sub ? 3 : 2}. HyperCore: spotSend ${usd(total)} USDC to ${HYPERCORE_USDC_SYSTEM_ADDRESS} (HyperCore → HyperEVM; multisig)`,
    ...out.map((c) => `${(sub ? 3 : 2) + c.index}. HyperEVM (999): Across SpokePool deposit ${usd(c.inputAmount)} → USDG on chain ${originChainId}, recipient ${vaultAddress}, depositor = the multisig's EVM address${c.outputAmount !== undefined ? `, outputAmount ≥ ${usd(c.outputAmount)} (${c.feeBps} bps), quoteTimestamp ${c.quoteTimestamp}, fillDeadline ${c.fillDeadline} (re-quote before signing)` : ""}`),
    `Then the keeper sees the USDG on the vault and sends reportClosed(${decisionId}); anything arriving after finalizeClose is picked up by reconcile().`,
  ];
  const alternative = [
    `HyperCore: withdraw3 ${usd(total)} to Arbitrum (${ARBITRUM_CHAIN_ID}), ~3–5 min, 1 USDC fee (multisig)`,
    `Arbitrum: Across deposit USDC 42161 → USDG 4663 to ${vaultAddress} (or Swap API), split by /limits`,
  ];
  warnings.push(`quoteTimestamp must be within ${DEPOSIT_QUOTE_TIME_BUFFER}s and fillDeadline within ${FILL_DEADLINE_BUFFER}s of the deposit block: quotes above are indicative`);
  return { decisionId, total, chunks: out, limits, route, recipient: vaultAddress, steps, alternative, warnings };
}

export function formatReturnPlan(p: ReturnPlan): string {
  const lines = [
    `RETURN PLAN decision ${p.decisionId}: ${(Number(p.total) / 1e6).toFixed(2)} USDC → vault ${p.recipient}`,
    `route ${p.route.originChainId} ${p.route.inputToken} → ${p.route.destinationChainId} ${p.route.outputToken}`,
    `limits: min ${p.limits.minDeposit} instant ${p.limits.maxDepositInstant} max ${p.limits.maxDeposit}`,
    ...p.steps,
    "alternative:",
    ...p.alternative.map((s) => `  - ${s}`),
    ...(p.warnings.length ? ["warnings:", ...p.warnings.map((w) => `  ! ${w}`)] : []),
    "The keeper cannot sign any of these steps (agent key, trading only).",
  ];
  return lines.join("\n");
}
