/**
 * Pure planning functions. They take observed state (vault, governance, Hyperliquid, Across) and return the action the
 * keeper WOULD take, with every bound re-checked locally so that an out-of-bounds plan is refused before any
 * transaction or order is built. Nothing here performs I/O; everything is unit-testable.
 *
 * Source of truth: the vault and governance. The keeper never invents a trade: asset/side come from
 * `governance.currentDecision()`, leverage / stop-loss / take-profit from `vault.riskParams()`, capital from the
 * vault's recorded position.
 */
import type { Address } from "viem";
import type { Config } from "./config.js";
import { absDecimal, cmpDecimals, divDecimals, mulBps, roundPrice, roundSize } from "./hyperliquid/rounding.js";
import type { AcrossLimits, AcrossQuote, GovernanceSnapshot, HlPosition, PerpMeta, RiskParams, Side, VaultSnapshot } from "./types.js";

export const BPS = 10_000n;
/** Across SpokePool constants (verified on-chain, VAULT.md §4). */
export const DEPOSIT_QUOTE_TIME_BUFFER = 3600;
export const FILL_DEADLINE_BUFFER = 21_600;

export interface ConvertPlan {
  kind: "convert";
  amountIn: bigint;
  /** ≥ the vault's `twapFloor(amountIn)` by construction. */
  minOut: bigint;
  floor: bigint;
  spotQuote: bigint;
}

export interface ExecutePlan {
  kind: "executeDecision";
  decisionId: bigint;
  asset: number;
  coin: string;
  side: Side;
  amount: bigint;
  outputAmount: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  /** Effective bridge fee in bps of `amount`. */
  feeBps: number;
  estimatedFillTimeSec: number;
  /** Deposit id the SpokePool will assign (= numberOfDeposits at send time; re-read from the receipt in live mode). */
  expectedDepositId: bigint;
}

export interface OpenPlan {
  kind: "openPosition";
  decisionId: bigint;
  asset: number;
  coin: string;
  side: Side;
  isBuy: boolean;
  leverage: number;
  /** Margin (USDC, decimal string) the position is sized on. */
  margin: string;
  /** Worst acceptable IOC price. */
  limitPx: string;
  size: string;
  mid: string;
  szDecimals: number;
}

export interface ProtectPlan {
  kind: "protect";
  decisionId: bigint;
  asset: number;
  coin: string;
  side: Side;
  /** Position size (absolute, decimal string) to cover. */
  size: string;
  entryPx: string;
  stopLossPx: string;
  takeProfitPx?: string;
  szDecimals: number;
}

export interface ClosePlan {
  kind: "closePosition";
  asset: number;
  coin: string;
  /** Side of the CLOSING order (opposite of the position). */
  isBuy: boolean;
  size: string;
  limitPx: string;
  reason: string;
}

export type Refusal = { kind: "refused"; what: string; reason: string };
export type Wait = { kind: "wait"; what: string; reason: string; until?: number };

export const refused = (what: string, reason: string): Refusal => ({ kind: "refused", what, reason });
export const wait = (what: string, reason: string, until?: number): Wait => ({ kind: "wait", what, reason, until });

// -------------------------------------------------------------------------------------------------------------------
// Conversion ETH → USDG
// -------------------------------------------------------------------------------------------------------------------

/**
 * @param floor `vault.twapFloor(amountIn)` for the amount chosen by {@link convertAmount} (read on-chain).
 * @param spotQuote QuoterV2 output for the same amount.
 */
export function planConvert(
  vault: VaultSnapshot,
  floor: bigint,
  spotQuote: bigint,
  cfg: Pick<Config, "minConvertWei" | "convertSlippageBps">,
  now: number,
): ConvertPlan | Wait | Refusal | undefined {
  const amountIn = convertAmount(vault, cfg.minConvertWei);
  if (amountIn === 0n) return undefined;
  if (vault.paused) return refused("convert", "vault paused");
  const nextAllowedAt = vault.lastConvertAt + vault.convertCooldown;
  if (now < nextAllowedAt) return wait("convert", "cooldown", nextAllowedAt);
  if (floor === 0n) return refused("convert", "twap floor is zero");
  // never below the on-chain floor (the tx would revert anyway), and never much below spot either
  const fromSpot = (spotQuote * (BPS - BigInt(cfg.convertSlippageBps))) / BPS;
  const minOut = fromSpot > floor ? fromSpot : floor;
  if (spotQuote < floor) return wait("convert", `spot ${spotQuote} below TWAP floor ${floor}: wait for the TWAP to catch up`);
  return { kind: "convert", amountIn, minOut, floor, spotQuote };
}

export function convertAmount(vault: Pick<VaultSnapshot, "ethBalance" | "maxConvertPerCall">, minConvertWei: bigint): bigint {
  const amount = vault.ethBalance < vault.maxConvertPerCall ? vault.ethBalance : vault.maxConvertPerCall;
  return amount < minConvertWei ? 0n : amount;
}

// -------------------------------------------------------------------------------------------------------------------
// executeDecision (bridge out through Across)
// -------------------------------------------------------------------------------------------------------------------

/** Whether the current decision can be executed right now, mirroring `WarchestVault._checkDecision`. */
export function decisionExecutable(vault: VaultSnapshot, gov: GovernanceSnapshot, now: number): Refusal | undefined {
  const d = gov.decision;
  if (d.id === 0n) return refused("executeDecision", "no decision");
  if (d.id <= vault.lastExecutedDecisionId) return refused("executeDecision", `decision ${d.id} already executed (last ${vault.lastExecutedDecisionId})`);
  if (vault.position.decisionId !== 0n) return refused("executeDecision", `position ${vault.position.decisionId} still open`);
  if (vault.paused) return refused("executeDecision", "vault paused");
  if (gov.paused) return refused("executeDecision", "governance paused");
  if (!gov.round || gov.round.endsAt === 0) return refused("executeDecision", "round not found");
  if (now > gov.round.endsAt + vault.maxDecisionAge) return refused("executeDecision", `decision stale (round ended ${gov.round.endsAt}, max age ${vault.maxDecisionAge})`);
  return undefined;
}

/** Amount to bridge: the vault cap, the accounted USDG and the Across instant limit, whichever is lowest. */
export function bridgeAmount(vault: Pick<VaultSnapshot, "maxOrderAmount" | "usdgLedger">, limits: AcrossLimits): bigint {
  let amount = vault.maxOrderAmount < vault.usdgLedger ? vault.maxOrderAmount : vault.usdgLedger;
  // one deposit, filled by a single relayer: stay within what relayers fill instantly
  if (limits.maxDepositInstant > 0n && amount > limits.maxDepositInstant) amount = limits.maxDepositInstant;
  if (limits.maxDeposit > 0n && amount > limits.maxDeposit) amount = limits.maxDeposit;
  return amount;
}

export function planExecute(
  vault: VaultSnapshot,
  gov: GovernanceSnapshot,
  universe: PerpMeta[],
  limits: AcrossLimits,
  quote: AcrossQuote,
  amount: bigint,
  cfg: Pick<Config, "allowedAssets" | "minFillMarginSec">,
  now: number,
): ExecutePlan | Wait | Refusal {
  const blocked = decisionExecutable(vault, gov, now);
  if (blocked) return blocked;
  const d = gov.decision;
  const perp = universe[d.asset];
  if (!perp) return refused("executeDecision", `unknown Hyperliquid asset index ${d.asset}`);
  if (perp.isDelisted) return refused("executeDecision", `asset ${perp.name} is delisted`);
  if (!cfg.allowedAssets.includes(perp.name)) return refused("executeDecision", `asset ${perp.name} not in the keeper allowlist`);
  if (perp.maxLeverage < vault.risk.leverage) return refused("executeDecision", `asset ${perp.name} max leverage ${perp.maxLeverage} < vault leverage ${vault.risk.leverage}`);

  if (amount === 0n) return wait("executeDecision", "nothing to bridge (ledger or cap is zero)");
  if (amount > vault.maxOrderAmount) return refused("executeDecision", `amount ${amount} > cap ${vault.maxOrderAmount}`);
  if (amount > vault.usdgLedger) return refused("executeDecision", `amount ${amount} > ledger ${vault.usdgLedger}`);
  if (amount < limits.minDeposit) return wait("executeDecision", `amount ${amount} below Across minDeposit ${limits.minDeposit}`);
  if (limits.maxDeposit > 0n && amount > limits.maxDeposit) return wait("executeDecision", `amount ${amount} above Across maxDeposit ${limits.maxDeposit}`);
  if (quote.isAmountTooLow) return wait("executeDecision", "Across: amount too low");

  const minOutput = (amount * (BPS - BigInt(vault.maxBridgeFeeBps))) / BPS;
  if (quote.outputAmount < minOutput) {
    return wait("executeDecision", `bridge fee too high: output ${quote.outputAmount} < ${minOutput} (max ${vault.maxBridgeFeeBps} bps)`);
  }
  if (quote.outputAmount > amount) return refused("executeDecision", `quote output ${quote.outputAmount} > input ${amount}`);
  if (quote.timestamp > now || now - quote.timestamp > DEPOSIT_QUOTE_TIME_BUFFER - 120) {
    return wait("executeDecision", `quote timestamp ${quote.timestamp} outside the SpokePool window at ${now}`);
  }
  if (quote.fillDeadline <= now + cfg.minFillMarginSec) return wait("executeDecision", `fill deadline ${quote.fillDeadline} too close`);
  if (quote.fillDeadline > now + FILL_DEADLINE_BUFFER) return refused("executeDecision", `fill deadline ${quote.fillDeadline} beyond the SpokePool buffer`);
  if (quote.spokePoolAddress.toLowerCase() !== vault.spokePool.toLowerCase()) {
    return refused("executeDecision", `Across spoke pool ${quote.spokePoolAddress} != vault spoke pool ${vault.spokePool}`);
  }
  const feeBps = Number(((amount - quote.outputAmount) * BPS) / amount);
  return {
    kind: "executeDecision",
    decisionId: d.id,
    asset: d.asset,
    coin: perp.name,
    side: d.side,
    amount,
    outputAmount: quote.outputAmount,
    quoteTimestamp: quote.timestamp,
    fillDeadline: quote.fillDeadline,
    feeBps,
    estimatedFillTimeSec: quote.estimatedFillTimeSec,
    expectedDepositId: vault.spokePoolNumberOfDeposits,
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Hyperliquid position
// -------------------------------------------------------------------------------------------------------------------

/** Distance of the stop from the entry that would already be past the isolated liquidation price (rough, conservative). */
export function maxSafeStopBps(leverage: number): number {
  // isolated liquidation ≈ 1/leverage of the price minus maintenance margin; keep the stop within 80 % of that
  return Math.floor((10_000 / leverage) * 0.8);
}

/**
 * Sizes the entry: margin × leverage × buffer, at the worst acceptable IOC price. `margin` is the USDC actually
 * available on the trading account (decimal string), never more than the vault's recorded capital.
 */
export function planOpen(
  vault: VaultSnapshot,
  perp: PerpMeta,
  mid: string,
  availableUsd: string,
  cfg: Pick<Config, "entrySlippageBps" | "sizeBufferBps" | "allowedAssets">,
): OpenPlan | Refusal {
  const p = vault.position;
  if (p.decisionId === 0n) return refused("openPosition", "no vault position");
  if (p.asset !== perp.index) return refused("openPosition", `perp index ${perp.index} != vault position asset ${p.asset}`);
  if (!cfg.allowedAssets.includes(perp.name)) return refused("openPosition", `asset ${perp.name} not in the keeper allowlist`);
  if (perp.isDelisted) return refused("openPosition", `asset ${perp.name} is delisted`);
  const risk = vault.risk;
  if (risk.leverage < 1 || risk.leverage > perp.maxLeverage) return refused("openPosition", `leverage ${risk.leverage} not allowed for ${perp.name}`);
  if (risk.stopLossBps > maxSafeStopBps(risk.leverage)) {
    return refused("openPosition", `stop-loss ${risk.stopLossBps} bps is beyond the safe distance for ${risk.leverage}x`);
  }
  if (cmpDecimals(mid, "0") <= 0) return refused("openPosition", "no mid price");
  // never size on more than the vault's recorded capital (6 decimals), even if more USDC sits on the account
  const capital = formatUsd6(p.capital);
  const margin = cmpDecimals(availableUsd, capital) < 0 ? availableUsd : capital;
  if (cmpDecimals(margin, "0") <= 0) return refused("openPosition", "no margin available");
  const isBuy = p.side === "long";
  const limitPx = roundPrice(mulBps(mid, isBuy ? 10_000 + cfg.entrySlippageBps : 10_000 - cfg.entrySlippageBps), perp.szDecimals, isBuy ? "up" : "down");
  const notional = mulBps(mulBps(margin, risk.leverage * 10_000), cfg.sizeBufferBps);
  const size = roundSize(divDecimals(notional, limitPx), perp.szDecimals);
  if (cmpDecimals(size, "0") <= 0) return refused("openPosition", `size rounds to zero for ${perp.name}`);
  return {
    kind: "openPosition",
    decisionId: p.decisionId,
    asset: perp.index,
    coin: perp.name,
    side: p.side,
    isBuy,
    leverage: risk.leverage,
    margin,
    limitPx,
    size,
    mid,
    szDecimals: perp.szDecimals,
  };
}

/** Stop-loss (mandatory) and take-profit (optional) trigger prices for a filled position. */
export function planProtect(
  vault: VaultSnapshot,
  perp: PerpMeta,
  hlPos: HlPosition,
  opts: { takeProfitTrigger: boolean },
): ProtectPlan | Refusal {
  const p = vault.position;
  if (p.decisionId === 0n) return refused("protect", "no vault position");
  if (hlPos.coin !== perp.name) return refused("protect", `position coin ${hlPos.coin} != ${perp.name}`);
  const size = absDecimal(hlPos.szi);
  if (cmpDecimals(size, "0") <= 0) return refused("protect", "flat position");
  const isLong = !hlPos.szi.startsWith("-");
  if ((p.side === "long") !== isLong) return refused("protect", `position side on Hyperliquid (${isLong ? "long" : "short"}) != decision ${p.side}`);
  if (!hlPos.entryPx) return refused("protect", "no entry price");
  const risk = vault.risk;
  const { stopLossPx, takeProfitPx } = protectionPrices(hlPos.entryPx, p.side, risk, perp.szDecimals);
  return {
    kind: "protect",
    decisionId: p.decisionId,
    asset: perp.index,
    coin: perp.name,
    side: p.side,
    size,
    entryPx: hlPos.entryPx,
    stopLossPx,
    takeProfitPx: opts.takeProfitTrigger ? takeProfitPx : undefined,
    szDecimals: perp.szDecimals,
  };
}

/**
 * - stop-loss: `stopLossBps` of the ENTRY PRICE (VAULT.md: "distance ... in bps of the entry price");
 * - take-profit: `takeProfitBps` of the CAPITAL, i.e. a price move of `takeProfitBps / leverage`.
 * Prices are rounded AWAY from the entry for the stop (triggers no earlier than mandated) and TOWARD the entry for
 * the take-profit (triggers no later than mandated).
 */
export function protectionPrices(entryPx: string, side: Side, risk: RiskParams, szDecimals: number): { stopLossPx: string; takeProfitPx: string } {
  const tpMoveBps = Math.floor(risk.takeProfitBps / risk.leverage);
  if (side === "long") {
    return {
      stopLossPx: roundPrice(mulBps(entryPx, 10_000 - risk.stopLossBps), szDecimals, "down"),
      takeProfitPx: roundPrice(mulBps(entryPx, 10_000 + tpMoveBps), szDecimals, "down"),
    };
  }
  return {
    stopLossPx: roundPrice(mulBps(entryPx, 10_000 + risk.stopLossBps), szDecimals, "up"),
    takeProfitPx: roundPrice(mulBps(entryPx, 10_000 - tpMoveBps), szDecimals, "up"),
  };
}

/** Reduce-only IOC that flattens `hlPos` at a bounded price. */
export function planClose(perp: PerpMeta, hlPos: HlPosition, mid: string, slippageBps: number, reason: string): ClosePlan | Refusal {
  const size = absDecimal(hlPos.szi);
  if (cmpDecimals(size, "0") <= 0) return refused("closePosition", "flat position");
  if (cmpDecimals(mid, "0") <= 0) return refused("closePosition", "no mid price");
  const isLong = !hlPos.szi.startsWith("-");
  const isBuy = !isLong;
  const limitPx = roundPrice(mulBps(mid, isBuy ? 10_000 + slippageBps : 10_000 - slippageBps), perp.szDecimals, isBuy ? "up" : "down");
  return { kind: "closePosition", asset: perp.index, coin: perp.name, isBuy, size: roundSize(size, perp.szDecimals), limitPx, reason };
}

export function formatUsd6(x: bigint): string {
  const s = x.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
}

export const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && (x as Refusal).kind === "refused";
export const isWait = (x: unknown): x is Wait => typeof x === "object" && x !== null && (x as Wait).kind === "wait";

export type PlannerAddress = Address;
