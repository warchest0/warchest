/**
 * Holder level math, mirroring the indexer (`indexer/src/lots.ts`):
 * - a lot is dated by the UTC day it was acquired;
 * - its level at the snapshot of day `D` is `clamp(D - lot.day, 0, MAX_LEVEL)`: 0 on the acquisition day, +1 at
 *   every UTC midnight, capped at 10;
 * - voting weight = Σ lot.amount × level(lot).
 */
export const DAY = 86_400;
export const MAX_LEVEL = 10;

export interface Lot {
  /** Token amount in base units. */
  amount: bigint;
  /** UTC day index of acquisition (`floor(timestamp / 86400)`). */
  day: number;
}

export function dayOf(timestampSec: number): number {
  return Math.floor(timestampSec / DAY);
}

export function levelAt(lotDay: number, day: number): number {
  return Math.max(0, Math.min(MAX_LEVEL, day - lotDay));
}

export function weightOf(lots: readonly Lot[], day: number): bigint {
  let w = 0n;
  for (const lot of lots) w += lot.amount * BigInt(levelAt(lot.day, day));
  return w;
}

export function balanceOf(lots: readonly Lot[]): bigint {
  return lots.reduce((s, l) => s + l.amount, 0n);
}

/**
 * Amount-weighted average level: the "your vote counts ×N" multiplier (weight / balance). Returned with two
 * decimals of precision as a number, 0 for an empty book.
 */
export function averageLevel(lots: readonly Lot[], day: number): number {
  const bal = balanceOf(lots);
  if (bal === 0n) return 0;
  return Number((weightOf(lots, day) * 100n) / bal) / 100;
}

/** Seconds until the next UTC midnight, i.e. until every lot below the cap gains a level. */
export function secondsToNextLevel(nowSec: number): number {
  return (dayOf(nowSec) + 1) * DAY - nowSec;
}

/** Progress (0..1) of the current UTC day, used to animate the ring towards the next level. */
export function dayProgress(nowSec: number): number {
  return (nowSec - dayOf(nowSec) * DAY) / DAY;
}

/** Day index at which a lot acquired on `lotDay` reaches the max level. */
export function maxLevelDay(lotDay: number): number {
  return lotDay + MAX_LEVEL;
}

/**
 * Current streak in days: consecutive days held by the OLDEST lot still in the book (LIFO sells never touch it
 * unless the wallet is emptied). Capped only by history, not by MAX_LEVEL.
 */
export function streakDays(lots: readonly Lot[], day: number): number {
  if (lots.length === 0) return 0;
  const oldest = lots.reduce((m, l) => Math.min(m, l.day), Number.POSITIVE_INFINITY);
  return Math.max(0, day - oldest);
}
