import type { Address, Hex } from "viem";

/** `IWarchestDecisionSource.Side` */
export type Side = "long" | "short";

export const sideFromEnum = (n: number): Side => {
  if (n === 0) return "long";
  if (n === 1) return "short";
  throw new Error(`invalid side enum ${n}`);
};

/** `IWarchestDecisionSource.Decision`, id 0 = none. */
export interface Decision {
  id: bigint;
  asset: number;
  side: Side;
  roundId: bigint;
  decidedAt: number;
}

/** `WarchestGovernance.Round` (only what the keeper needs). */
export interface Round {
  endsAt: number;
  finalized: boolean;
}

/** `WarchestVault.Position`, decisionId 0 = none. */
export interface VaultPosition {
  decisionId: bigint;
  asset: number;
  side: Side;
  /** USDG bridged out (6 decimals). */
  capital: bigint;
  openedAt: number;
  depositId: bigint;
  /** 0 = not closing. */
  closeReportedAt: number;
}

export interface RiskParams {
  stopLossBps: number;
  leverage: number;
  takeProfitBps: number;
}

/** Everything the keeper reads from the vault in one tick. */
export interface VaultSnapshot {
  paused: boolean;
  keeper: Address;
  ethBalance: bigint;
  usdgBalance: bigint;
  usdgLedger: bigint;
  nav: bigint;
  maxOrderAmount: bigint;
  lastConvertAt: number;
  convertCooldown: number;
  maxConvertPerCall: bigint;
  maxBridgeFeeBps: number;
  maxDecisionAge: number;
  reportChallengeWindow: number;
  lastExecutedDecisionId: bigint;
  position: VaultPosition;
  mustClose: boolean;
  risk: RiskParams;
  bridgeRecipient: Address;
  bridgeOutputToken: Address;
  destinationChainId: bigint;
  usdg: Address;
  spokePool: Address;
  spokePoolNumberOfDeposits: bigint;
  /** Chain time (seconds) of the block the snapshot was taken at. */
  blockTimestamp: number;
  blockNumber: bigint;
}

export interface GovernanceSnapshot {
  decision: Decision;
  round?: Round;
  closeRequested: boolean;
  paused: boolean;
}

/** Hyperliquid perp metadata (`meta.universe[i]`). */
export interface PerpMeta {
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted: boolean;
}

/** One open perp position as reported by `clearinghouseState`. */
export interface HlPosition {
  coin: string;
  /** Signed size (+ long, − short), as a decimal string. */
  szi: string;
  leverageType: "cross" | "isolated";
  leverage: number;
  entryPx?: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx?: string;
  marginUsed: string;
}

export interface HlAccountState {
  accountValue: string;
  totalMarginUsed: string;
  withdrawable: string;
  positions: HlPosition[];
}

export interface HlOpenOrder {
  coin: string;
  /** "B" = bid/buy, "A" = ask/sell. */
  side: "B" | "A";
  limitPx: string;
  sz: string;
  origSz: string;
  oid: number;
  timestamp: number;
  isTrigger: boolean;
  triggerPx: string;
  triggerCondition: string;
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: string;
  tif: string | null;
  cloid: Hex | null;
}

export interface HlAgent {
  address: Address;
  name: string;
  validUntil: number;
}

export type HlOrderStatus =
  | { status: "unknownOid" }
  | { status: "order"; state: "open" | "filled" | "canceled" | "triggered" | "rejected" | "marginCanceled" | string; order: HlOpenOrder };

/** Across `/suggested-fees` (only what we need). All amounts in the token's smallest unit (6 decimals here). */
export interface AcrossQuote {
  outputAmount: bigint;
  /** = quoteTimestamp for the deposit. */
  timestamp: number;
  fillDeadline: number;
  /** Total relay fee as a fraction with 1e18 = 100 %. */
  totalRelayFeePct: bigint;
  totalRelayFeeTotal: bigint;
  lpFeePct: bigint;
  estimatedFillTimeSec: number;
  isAmountTooLow: boolean;
  spokePoolAddress: Address;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  limits: AcrossLimits;
}

export interface AcrossLimits {
  minDeposit: bigint;
  maxDeposit: bigint;
  maxDepositInstant: bigint;
  maxDepositShortDelay: bigint;
  recommendedDepositInstant: bigint;
}

export type AcrossDepositStatus =
  | { status: "pending" }
  | { status: "filled"; fillTxHash?: Hex; fillTimestamp?: number }
  | { status: "expired" }
  | { status: "refunded"; refundTxHash?: Hex }
  | { status: "unknown"; raw?: unknown };
