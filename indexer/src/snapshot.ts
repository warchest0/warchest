import type { Address } from "viem";
import { LotBook } from "./lots.js";
import { DAY, type Transfer } from "./types.js";

export interface Snapshot {
  /** UTC day index = governance epoch. */
  day: number;
  weights: Map<Address, bigint>;
  totalWeight: bigint;
  holders: number;
}

/**
 * Snapshot at the END of UTC day `day`: every transfer with `timestamp < (day + 1) × 86400` is applied, in chain
 * order, then weights are read. Deterministic: same transfers + same exclusions ⇒ same snapshot.
 */
export function snapshotAt(transfers: Iterable<Transfer>, day: number, excluded: Iterable<Address>): Snapshot {
  const end = (day + 1) * DAY;
  const book = new LotBook(excluded);
  for (const t of transfers) {
    if (t.timestamp >= end) break; // transfers are in chain order, hence in timestamp order
    book.apply(t);
  }
  const weights = book.weights(day);
  let totalWeight = 0n;
  for (const w of weights.values()) totalWeight += w;
  return { day, weights, totalWeight, holders: book.holders() };
}
