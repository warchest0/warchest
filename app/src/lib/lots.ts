import { MAX_LEVEL, type Lot } from "./levels";
import { sellLifo } from "./lifo";

export interface WalletTransfer {
  /** UTC day index of the transfer's block. */
  day: number;
  /** Positive = received, negative = sent. */
  delta: bigint;
}

/** How many days of history are enough: anything older is at the max level whatever its exact age. */
export const LOT_WINDOW_DAYS = MAX_LEVEL;

/**
 * Rebuilds a wallet's LIFO lot book from its current balance and only the transfers of the last
 * `LOT_WINDOW_DAYS` days (chronological). Tokens already held before the window are necessarily at the max level,
 * so they are represented by a single lot dated just before the window: levels and weight are exact, only that
 * lot's true acquisition day (for the streak) is unknown.
 */
export function reconstructLots(balanceNow: bigint, transfers: readonly WalletTransfer[], windowStartDay: number): Lot[] {
  const net = transfers.reduce((s, t) => s + t.delta, 0n);
  const before = balanceNow - net;
  let book: Lot[] = before > 0n ? [{ amount: before, day: windowStartDay - 1 }] : [];
  for (const t of transfers) {
    if (t.delta > 0n) {
      const last = book[book.length - 1];
      if (last && last.day === t.day) last.amount += t.delta;
      else book.push({ amount: t.delta, day: t.day });
    } else if (t.delta < 0n) {
      const held = book.reduce((s, l) => s + l.amount, 0n);
      book = sellLifo(book, -t.delta > held ? held : -t.delta);
    }
  }
  return book;
}
