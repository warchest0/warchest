/**
 * Direction-round option encoding, identical to `WarchestGovernance.decodeOption`:
 * `option = assetIndex * 2 + side`, where `assetIndex` is the position in `roundAssets(roundId)` (NOT the
 * Hyperliquid asset index) and side is Long = 0, Short = 1. Close rounds use 0 = keep, 1 = close.
 */
export enum Side {
  Long = 0,
  Short = 1,
}

export interface DirectionOption {
  option: number;
  /** Position in the round's asset list. */
  assetIndex: number;
  /** Hyperliquid perp asset index. */
  asset: number;
  side: Side;
}

export function encodeOption(assetIndex: number, side: Side): number {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error(`invalid asset index ${assetIndex}`);
  return assetIndex * 2 + side;
}

export function decodeOption(option: number, roundAssets: readonly number[]): DirectionOption {
  if (!Number.isInteger(option) || option < 0 || option >= roundAssets.length * 2) {
    throw new Error(`invalid option ${option}`);
  }
  const assetIndex = Math.floor(option / 2);
  return { option, assetIndex, asset: roundAssets[assetIndex]!, side: (option % 2) as Side };
}

export function directionOptions(roundAssets: readonly number[]): DirectionOption[] {
  return roundAssets.flatMap((asset, assetIndex) =>
    [Side.Long, Side.Short].map((side) => ({ option: encodeOption(assetIndex, side), assetIndex, asset, side })),
  );
}

export function sideLabel(side: Side): "Long" | "Short" {
  return side === Side.Long ? "Long" : "Short";
}

export const CLOSE_OPTIONS = [
  { option: 0, label: "Keep open" },
  { option: 1, label: "Close position" },
] as const;

/** Index of the unique leader, or -1 when there is no vote or a tie (governance then falls back, D8). */
export function uniqueLeader(tallies: readonly bigint[]): number {
  let best = 0n;
  let winner = -1;
  let unique = true;
  tallies.forEach((w, i) => {
    if (w > best) {
      best = w;
      winner = i;
      unique = true;
    } else if (w === best && w > 0n) {
      unique = false;
    }
  });
  return unique ? winner : -1;
}

/** Quorum progress in basis points of the required quorum (10_000 = quorum reached exactly). */
export function quorumProgressBps(totalVoted: bigint, totalWeight: bigint, quorumBps: number): number {
  if (totalWeight === 0n || quorumBps === 0) return 0;
  const needed = (totalWeight * BigInt(quorumBps)) / 10_000n;
  if (needed === 0n) return 10_000;
  return Number((totalVoted * 10_000n) / needed);
}

export function isQuorate(totalVoted: bigint, totalWeight: bigint, quorumBps: number): boolean {
  return totalVoted * 10_000n >= BigInt(quorumBps) * totalWeight;
}
