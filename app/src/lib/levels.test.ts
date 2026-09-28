import { describe, expect, it } from "vitest";
import {
  DAY,
  averageLevel,
  dayOf,
  levelAt,
  secondsToNextLevel,
  streakDays,
  weightOf,
  type Lot,
} from "./levels";
import { sellLifo, simulateSell, simulateSellBps, weightIfFifo } from "./lifo";

const E = 10n ** 18n;

describe("levels", () => {
  it("is 0 on the acquisition day, +1 per UTC day, capped at 10", () => {
    expect(levelAt(100, 100)).toBe(0);
    expect(levelAt(100, 101)).toBe(1);
    expect(levelAt(100, 107)).toBe(7);
    expect(levelAt(100, 110)).toBe(10);
    expect(levelAt(100, 400)).toBe(10);
    expect(levelAt(100, 90)).toBe(0);
  });

  it("maps timestamps to UTC days", () => {
    expect(dayOf(0)).toBe(0);
    expect(dayOf(DAY - 1)).toBe(0);
    expect(dayOf(DAY)).toBe(1);
  });

  it("weight = sum of lot × level (same as the indexer)", () => {
    const lots: Lot[] = [
      { amount: 100n * E, day: 10 }, // level 10 on day 25
      { amount: 50n * E, day: 20 }, // level 5
      { amount: 30n * E, day: 25 }, // level 0
    ];
    expect(weightOf(lots, 25)).toBe(100n * E * 10n + 50n * E * 5n);
    // (1000 + 250) / 180 = 6.94
    expect(averageLevel(lots, 25)).toBeCloseTo(6.94, 2);
    expect(streakDays(lots, 25)).toBe(15);
  });

  it("counts down to the next UTC midnight", () => {
    expect(secondsToNextLevel(5 * DAY)).toBe(DAY);
    expect(secondsToNextLevel(5 * DAY + 3600)).toBe(DAY - 3600);
  });
});

describe("LIFO sell simulator", () => {
  const lots: Lot[] = [
    { amount: 100n, day: 0 },
    { amount: 40n, day: 5 },
    { amount: 60n, day: 9 },
  ];

  it("consumes the newest lots first", () => {
    expect(sellLifo(lots, 70n)).toEqual([
      { amount: 100n, day: 0 },
      { amount: 30n, day: 5 },
    ]);
    // the input is never mutated
    expect(lots[2]).toEqual({ amount: 60n, day: 9 });
  });

  it("rejects a sell larger than the balance", () => {
    expect(() => sellLifo(lots, 201n)).toThrow();
  });

  it("keeps the old lot's level on the rest", () => {
    const sim = simulateSellBps(lots, 5_000, 10); // sell 100 of 200
    expect(sim.sold).toBe(100n);
    expect(sim.remaining).toBe(100n);
    expect(sim.lotsAfter).toEqual([{ amount: 100n, day: 0 }]);
    expect(sim.avgLevelAfter).toBe(10);
    expect(sim.topLevelAfter).toBe(10);
    // before: 100×10 + 40×5 + 60×1 = 1260; after: 1000
    expect(sim.weightBefore).toBe(1260n);
    expect(sim.weightAfter).toBe(1000n);
    expect(sim.weightKeptBps).toBe(7936);
  });

  it("beats FIFO for the holder", () => {
    expect(simulateSell(lots, 100n, 10).weightAfter).toBeGreaterThan(weightIfFifo(lots, 100n, 10));
  });

  it("selling everything leaves nothing", () => {
    const sim = simulateSellBps(lots, 10_000, 10);
    expect(sim.remaining).toBe(0n);
    expect(sim.weightAfter).toBe(0n);
    expect(sim.avgLevelAfter).toBe(0);
  });
});
