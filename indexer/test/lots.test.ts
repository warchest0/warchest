import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { LotBook, MAX_LEVEL } from "../src/lots.js";
import { snapshotAt } from "../src/snapshot.js";
import { DAY, type Transfer } from "../src/types.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address; // PoolManager (excluded)
const A = getAddress("0x000000000000000000000000000000000000000a");
const B = getAddress("0x000000000000000000000000000000000000000b");

let n = 0;
const tx = (day: number, from: Address, to: Address, value: bigint, secondsIntoDay = 3600): Transfer => ({
  blockNumber: BigInt(++n),
  logIndex: 0,
  txHash: "0x00" as Hex,
  blockHash: "0x00" as Hex,
  timestamp: day * DAY + secondsIntoDay,
  from,
  to,
  value,
});

const weightOf = (transfers: Transfer[], day: number, w: Address) =>
  snapshotAt(transfers, day, [POOL]).weights.get(w) ?? 0n;

describe("levels (whitepaper §2.2)", () => {
  const history = [tx(0, POOL, A, 100n)]; // A buys 100 on day 0

  it("level 0 on the acquisition day, 1 after one day held", () => {
    expect(weightOf(history, 0, A)).toBe(0n);
    expect(weightOf(history, 1, A)).toBe(100n);
  });

  it("grows one level per day up to 10, then caps", () => {
    for (let d = 1; d <= 10; d++) expect(weightOf(history, d, A)).toBe(100n * BigInt(d));
    expect(weightOf(history, 25, A)).toBe(100n * BigInt(MAX_LEVEL));
  });

  it("1% at level 10 weighs like 10% at level 1 (whitepaper §2.3)", () => {
    const h = [tx(0, POOL, A, 1n), tx(9, POOL, B, 10n)];
    expect(weightOf(h, 10, A)).toBe(weightOf(h, 10, B));
  });
});

describe("LIFO (D1)", () => {
  it("selling consumes the most recent lots first", () => {
    const h = [tx(0, POOL, A, 100n), tx(5, POOL, A, 50n), tx(6, A, POOL, 60n)];
    // 50 (day 5) fully consumed, then 10 of the day-0 lot → 90 left from day 0
    expect(weightOf(h, 7, A)).toBe(90n * 7n);
    const book = new LotBook([POOL]);
    h.forEach((t) => book.apply(t));
    expect(book.lotsOf(A)).toEqual([{ amount: 90n, day: 0 }]);
  });

  it("trimming never touches old seniority when recent lots cover the sale", () => {
    const h = [tx(0, POOL, A, 100n), tx(8, POOL, A, 30n), tx(9, A, POOL, 30n)];
    expect(weightOf(h, 10, A)).toBe(100n * 10n);
  });

  it("wallet-to-wallet transfer: sender loses via LIFO, recipient starts at level 0", () => {
    const h = [tx(0, POOL, A, 100n), tx(5, A, B, 40n)];
    expect(weightOf(h, 5, B)).toBe(0n);
    expect(weightOf(h, 6, B)).toBe(40n);
    expect(weightOf(h, 6, A)).toBe(60n * 6n);
  });

  it("selling everything then re-buying restarts at level 0", () => {
    const h = [tx(0, POOL, A, 100n), tx(5, A, POOL, 100n), tx(6, POOL, A, 100n)];
    expect(weightOf(h, 7, A)).toBe(100n);
  });

  it("self-transfer is a no-op (does not reset seniority)", () => {
    const h = [tx(0, POOL, A, 100n), tx(9, A, A, 100n)];
    expect(weightOf(h, 10, A)).toBe(1000n);
  });

  it("same-day lots are merged", () => {
    const book = new LotBook([POOL]);
    [tx(3, POOL, A, 1n, 10), tx(3, POOL, A, 2n, 20), tx(4, POOL, A, 4n)].forEach((t) => book.apply(t));
    expect(book.lotsOf(A)).toEqual([
      { amount: 3n, day: 3 },
      { amount: 4n, day: 4 },
    ]);
  });
});

describe("snapshot boundaries & exclusions", () => {
  it("includes transfers strictly before the end of the day", () => {
    const h = [tx(0, POOL, A, 100n), tx(1, A, POOL, 100n, DAY - 1)]; // sold at 23:59:59 on day 1
    expect(weightOf(h, 1, A)).toBe(0n);
    expect(weightOf(h, 0, A)).toBe(0n);
  });

  it("excluded addresses and the zero address never hold weight", () => {
    const h = [tx(0, ZERO, A, 1000n), tx(0, A, POOL, 400n)];
    const s = snapshotAt(h, 5, [POOL]);
    expect([...s.weights.keys()]).toEqual([A]);
    expect(s.totalWeight).toBe(600n * 5n);
  });

  it("throws on an impossible history (missing transfers)", () => {
    const h = [tx(0, A, B, 1n)];
    expect(() => snapshotAt(h, 1, [POOL])).toThrow(/lot underflow/);
  });

  it("balances always equal the ERC20 balances implied by the history", () => {
    const wallets = [A, B, getAddress("0x000000000000000000000000000000000000000c")];
    const h: Transfer[] = [tx(0, ZERO, A, 1_000_000n)];
    const bal = new Map<Address, bigint>([[A, 1_000_000n]]);
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 500; i++) {
      const from = wallets[rnd() % 3]!;
      const to = wallets[rnd() % 3]!;
      const have = bal.get(from) ?? 0n;
      if (have === 0n) continue;
      const v = BigInt(rnd()) % have + 1n;
      h.push(tx(Math.floor(i / 20), from, to, v));
      bal.set(from, have - v);
      bal.set(to, (bal.get(to) ?? 0n) + v);
    }
    const book = new LotBook([POOL]);
    h.forEach((t) => book.apply(t));
    for (const w of wallets) expect(book.balanceOf(w)).toBe(bal.get(w) ?? 0n);
  });
});
