import { getAddress, type Address } from "viem";
import { dayOf, type Transfer } from "./types.js";

/** Holder level cap (whitepaper §2.2). */
export const MAX_LEVEL = 10;

/** Tokens acquired by a wallet on a given UTC day. */
export interface Lot {
  amount: bigint;
  /** UTC day index of acquisition. */
  day: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Per-wallet lot book with LIFO consumption (DECISIONS.md D1):
 * - receiving tokens (buy, transfer, mint) creates a lot dated the day of the transfer;
 * - sending tokens (sell, transfer, burn) consumes the MOST RECENT lots first, so trimming a position never
 *   destroys the seniority of older tokens;
 * - a self-transfer is a no-op (it must not reset seniority);
 * - excluded addresses (PoolManager, vault, hook, distributor, …) hold no lots and never vote.
 */
export class LotBook {
  private readonly lots = new Map<Address, Lot[]>();
  private readonly excluded: Set<string>;

  constructor(excluded: Iterable<Address> = []) {
    this.excluded = new Set([...excluded].map((a) => a.toLowerCase()));
    this.excluded.add(ZERO);
  }

  isExcluded(a: Address): boolean {
    return this.excluded.has(a.toLowerCase());
  }

  apply(t: Transfer): void {
    const from = t.from.toLowerCase() as Address;
    const to = t.to.toLowerCase() as Address;
    if (t.value === 0n || from === to) return;
    if (!this.excluded.has(from)) this.consume(from, t.value, t);
    if (!this.excluded.has(to)) this.receive(to, t.value, dayOf(t.timestamp));
  }

  private receive(wallet: Address, amount: bigint, day: number): void {
    const book = this.lots.get(wallet);
    if (!book) {
      this.lots.set(wallet, [{ amount, day }]);
      return;
    }
    const last = book[book.length - 1];
    // merging same-day lots keeps the book small and does not change any weight
    if (last && last.day === day) last.amount += amount;
    else book.push({ amount, day });
  }

  private consume(wallet: Address, amount: bigint, t: Transfer): void {
    const book = this.lots.get(wallet);
    let left = amount;
    while (left > 0n && book && book.length > 0) {
      const last = book[book.length - 1]!;
      if (last.amount <= left) {
        left -= last.amount;
        book.pop();
      } else {
        last.amount -= left;
        left = 0n;
      }
    }
    if (left > 0n) {
      // cannot happen for a correct ERC20 history: the indexer is missing transfers or the exclusion list is wrong
      throw new Error(`lot underflow for ${wallet} at block ${t.blockNumber} log ${t.logIndex}: missing ${left}`);
    }
    if (book && book.length === 0) this.lots.delete(wallet);
  }

  balanceOf(wallet: Address): bigint {
    return (this.lots.get(wallet.toLowerCase() as Address) ?? []).reduce((s, l) => s + l.amount, 0n);
  }

  lotsOf(wallet: Address): readonly Lot[] {
    return this.lots.get(wallet.toLowerCase() as Address) ?? [];
  }

  /** Level of a lot at the snapshot of `day`: whole days held, capped at MAX_LEVEL (0 on its acquisition day). */
  static level(lot: Lot, day: number): number {
    return Math.max(0, Math.min(MAX_LEVEL, day - lot.day));
  }

  /** Voting weight of every wallet at the snapshot of `day`: Σ lot.amount × level(lot). Zero weights omitted. */
  weights(day: number): Map<Address, bigint> {
    const out = new Map<Address, bigint>();
    for (const [wallet, book] of this.lots) {
      let w = 0n;
      for (const lot of book) w += lot.amount * BigInt(LotBook.level(lot, day));
      if (w > 0n) out.set(getAddress(wallet), w);
    }
    return out;
  }

  holders(): number {
    return this.lots.size;
  }
}
