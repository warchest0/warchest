import { describe, expect, it } from "vitest";
import { levelAt, weightOf } from "./levels";
import { reconstructLots } from "./lots";

describe("lot reconstruction from a bounded transfer window", () => {
  const today = 100;
  const windowStart = today - 10;

  it("puts pre-window tokens in one max-level lot and replays the window with LIFO", () => {
    // balance 1000 now; in the window: +300 (day 95), +200 (day 98), -250 (day 99)
    const lots = reconstructLots(
      1000n,
      [
        { day: 95, delta: 300n },
        { day: 98, delta: 200n },
        { day: 99, delta: -250n },
      ],
      windowStart,
    );
    expect(lots).toEqual([
      { amount: 750n, day: 89 },
      { amount: 250n, day: 95 },
    ]);
    expect(levelAt(lots[0]!.day, today)).toBe(10);
    expect(weightOf(lots, today)).toBe(750n * 10n + 250n * 5n);
  });

  it("merges same-day receipts and handles an emptied wallet", () => {
    expect(reconstructLots(0n, [{ day: 96, delta: 10n }, { day: 96, delta: 5n }, { day: 97, delta: -15n }], windowStart)).toEqual([]);
    expect(reconstructLots(15n, [{ day: 96, delta: 10n }, { day: 96, delta: 5n }], windowStart)).toEqual([{ amount: 15n, day: 96 }]);
  });
});
