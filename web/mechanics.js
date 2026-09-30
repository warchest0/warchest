/** Matches indexer/src/lots.ts: acquisition day is 0, full UTC days, capped at 10. */
export function lotLevel(days) {
  if (!Number.isFinite(days)) throw new TypeError('Days must be finite');
  return Math.max(0, Math.min(10, Math.floor(days)));
}
export function votingWeight(amount, days) {
  if (typeof amount !== 'bigint' || amount < 0n) throw new TypeError('Amount must be a nonnegative bigint');
  return amount * BigInt(lotLevel(days));
}
