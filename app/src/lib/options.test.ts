import { describe, expect, it } from "vitest";
import { Side, decodeOption, directionOptions, encodeOption, isQuorate, quorumProgressBps, uniqueLeader } from "./options";

describe("vote option encoding", () => {
  const roundAssets = [0, 1, 5]; // BTC, ETH, SOL (Hyperliquid indices)

  it("encodes assetIndex * 2 + side", () => {
    expect(encodeOption(0, Side.Long)).toBe(0);
    expect(encodeOption(0, Side.Short)).toBe(1);
    expect(encodeOption(2, Side.Long)).toBe(4);
    expect(encodeOption(2, Side.Short)).toBe(5);
  });

  it("decodes to the round's asset list position, not the HL index", () => {
    expect(decodeOption(5, roundAssets)).toEqual({ option: 5, assetIndex: 2, asset: 5, side: Side.Short });
    expect(decodeOption(2, roundAssets)).toEqual({ option: 2, assetIndex: 1, asset: 1, side: Side.Long });
    expect(() => decodeOption(6, roundAssets)).toThrow();
    expect(() => decodeOption(-1, roundAssets)).toThrow();
  });

  it("round-trips every option", () => {
    const opts = directionOptions(roundAssets);
    expect(opts).toHaveLength(6);
    for (const o of opts) expect(decodeOption(encodeOption(o.assetIndex, o.side), roundAssets)).toEqual(o);
  });

  it("detects ties like governance (no unique leader → fallback)", () => {
    expect(uniqueLeader([0n, 5n, 3n])).toBe(1);
    expect(uniqueLeader([5n, 5n, 3n])).toBe(-1);
    expect(uniqueLeader([0n, 0n])).toBe(-1);
  });

  it("computes quorum like governance", () => {
    expect(isQuorate(100n, 1000n, 1000)).toBe(true);
    expect(isQuorate(99n, 1000n, 1000)).toBe(false);
    expect(quorumProgressBps(50n, 1000n, 1000)).toBe(5000);
  });
});
