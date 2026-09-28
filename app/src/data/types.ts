import type { Address, Hex } from "viem";
import type { Lot } from "@/lib/levels";
import type { Side } from "@/lib/options";

export type DataMode = "demo" | "onchain";

export interface RiskParams {
  stopLossBps: number;
  leverage: number;
  takeProfitBps: number;
}

export interface OpenPosition {
  decisionId: bigint;
  /** Hyperliquid perp asset index. */
  asset: number;
  side: Side;
  /** USDG bridged out for this position (6 decimals). */
  capital: bigint;
  openedAt: number;
  /** Keeper close report timestamp; 0 = not closing. */
  closeReportedAt: number;
  /** Latest matured keeper equity report, if any (6 decimals). */
  equity?: bigint;
}

export interface TreasuryState {
  /** Liquid NAV in USDG (6 decimals): USDG + ETH valued at the conversion floor. */
  nav: bigint;
  usdgLedger: bigint;
  maxOrder: bigint;
  capBps: number;
  paused: boolean;
  mustClose: boolean;
  position: OpenPosition | null;
  risk: RiskParams;
  cumulativePnl: bigint;
  highWaterMark: bigint;
  distributable: bigint;
  distributorEnabled: boolean;
  closeVoteAllowed: boolean;
  /** Fees collected in ETH (demo only; on-chain this needs an indexer). */
  feesEth?: bigint;
}

export type VaultEventKind =
  | "fee"
  | "conversion"
  | "order"
  | "report"
  | "closeReported"
  | "closed"
  | "lateReturn"
  | "distributed"
  | "paused";

export interface VaultEvent {
  id: string;
  kind: VaultEventKind;
  timestamp: number;
  txHash?: Hex;
  title: string;
  detail: string;
  /** Signed PnL for closes (6 decimals). */
  pnl?: bigint;
}

export interface PnlPoint {
  timestamp: number;
  /** Cumulative realized PnL in USD (float, chart only). */
  cumulativePnl: number;
}

export type RoundKind = "direction" | "close";

export interface RoundView {
  id: bigint;
  kind: RoundKind;
  epoch: number;
  startsAt: number;
  endsAt: number;
  finalized: boolean;
  voided: boolean;
  totalVoted: bigint;
  /** Total weight of the round's snapshot (quorum denominator). */
  totalWeight: bigint;
  quorumBps: number;
  /** Direction rounds: Hyperliquid asset indices, in option order (`roundAssets`). */
  assets: number[];
  /** Weight per option (`tally`). */
  tallies: bigint[];
  targetDecisionId: bigint;
  /** Whether the connected account already voted. */
  hasVoted: boolean;
  voters?: number;
}

export interface ActiveRounds {
  direction: RoundView | null;
  close: RoundView | null;
  paused: boolean;
}

export type RoundOutcome = "decision" | "fallback" | "close" | "keep" | "void" | "pending";

export interface PastRound {
  id: bigint;
  kind: RoundKind;
  endsAt: number;
  outcome: RoundOutcome;
  quorate: boolean;
  totalVoted: bigint;
  totalWeight: bigint;
  /** Winning option, when unique. */
  winner?: { asset?: number; side?: Side; option: number; weight: bigint };
  /** Realized PnL of the position opened by this decision, if closed. */
  pnl?: bigint;
}

export interface HolderState {
  account: Address;
  balance: bigint;
  /** Oldest → newest. */
  lots: Lot[];
  /** Weight in the latest published snapshot, when the account is in the tree. */
  snapshotWeight?: bigint;
  snapshotEpoch?: number;
  rank?: number;
  holders?: number;
  /** Lots whose exact acquisition day is unknown because they predate the scanned window (all at max level). */
  approximate?: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  account: Address;
  weight: bigint;
  /** Share of the snapshot's total weight, 0..1. */
  share: number;
}

export interface Leaderboard {
  epoch: number;
  totalWeight: bigint;
  entries: LeaderboardEntry[];
  /** Root recomputed from the published file matches the on-chain root. */
  rootVerified: boolean | null;
}

export interface ClaimState {
  enabled: boolean;
  cumulative: bigint;
  claimed: bigint;
  claimable: bigint;
  proof: Hex[];
}

export interface VoteProof {
  weight: bigint;
  proof: Hex[];
}

/** One interface, two implementations (demo mock and on-chain reader). Hooks only talk to this. */
export interface DataProvider {
  mode: DataMode;
  getTreasury(): Promise<TreasuryState>;
  getVaultEvents(): Promise<VaultEvent[]>;
  getPnlHistory(): Promise<PnlPoint[]>;
  getActiveRounds(account?: Address): Promise<ActiveRounds>;
  getPastRounds(): Promise<PastRound[]>;
  getHolder(account: Address): Promise<HolderState>;
  getLeaderboard(): Promise<Leaderboard>;
  getVoteProof(epoch: number, account: Address): Promise<VoteProof | null>;
  getClaim(account: Address): Promise<ClaimState | null>;
}
