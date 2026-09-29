import { averageLevel, balanceOf, levelAt, weightOf, type Lot } from "./levels";

/**
 * LIFO consumption (DECISIONS.md D1): a sale consumes the most recently acquired tokens first, so trimming a
 * position never resets the seniority of older tokens. `lots` must be sorted oldest → newest (as the indexer does).
 */
export function sellLifo(lots: readonly Lot[], amount: bigint): Lot[] {
  if (amount < 0n) throw new Error("negative sell amount");
  const book = lots.map((l) => ({ ...l }));
  let left = amount;
  while (left > 0n && book.length > 0) {
    const last = book[book.length - 1]!;
    if (last.amount <= left) {
      left -= last.amount;
      book.pop();
    } else {
      last.amount -= left;
      left = 0n;
    }
  }
  if (left > 0n) throw new Error("sell amount exceeds balance");
  return book;
}

export interface SellSimulation {
  sold: bigint;
  remaining: bigint;
  weightBefore: bigint;
  weightAfter: bigint;
  avgLevelBefore: number;
  avgLevelAfter: number;
  /** Highest level still held after the sale (0 when nothing is left). */
  topLevelAfter: number;
  /** Share of the weight kept, in basis points. */
  weightKeptBps: number;
  lotsAfter: Lot[];
}

/** Simulates selling `bps` basis points (0..10_000) of the balance. */
export function simulateSellBps(lots: readonly Lot[], bps: number, day: number): SellSimulation {
  const clamped = Math.max(0, Math.min(10_000, Math.round(bps)));
  const balance = balanceOf(lots);
  const sold = (balance * BigInt(clamped)) / 10_000n;
  return simulateSell(lots, sold, day);
}

export function simulateSell(lots: readonly Lot[], amount: bigint, day: number): SellSimulation {
  const lotsAfter = sellLifo(lots, amount);
  const weightBefore = weightOf(lots, day);
  const weightAfter = weightOf(lotsAfter, day);
  return {
    sold: amount,
    remaining: balanceOf(lotsAfter),
    weightBefore,
    weightAfter,
    avgLevelBefore: averageLevel(lots, day),
    avgLevelAfter: averageLevel(lotsAfter, day),
    topLevelAfter: lotsAfter.reduce((m, l) => Math.max(m, levelAt(l.day, day)), 0),
    weightKeptBps: weightBefore === 0n ? 0 : Number((weightAfter * 10_000n) / weightBefore),
    lotsAfter,
  };
}

/** Naive FIFO counterpart, only used to show the benefit of LIFO in the UI. */
export function weightIfFifo(lots: readonly Lot[], amount: bigint, day: number): bigint {
  return weightOf(sellLifo([...lots].reverse(), amount).reverse(), day);
}
