import { describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, keccak256, type Address } from "viem";
import { addDistribution, buildDistributionTree, DIST_LEAF_TYPES } from "../src/distribution.js";

const a = (i: number) => getAddress(`0x${i.toString(16).padStart(40, "0")}`) as Address;
const DIST = a(0xd15);

describe("distribution trees", () => {
  it("splits pro-rata to level-weighted weights and accumulates", () => {
    const w = new Map([[a(1), 10_000n], [a(2), 6_000n], [a(3), 4_000n]]);
    const c1 = addDistribution(new Map(), 1_000_000n, w);
    expect([...c1.values()]).toEqual([500_000n, 300_000n, 200_000n]);
    const c2 = addDistribution(c1, 100n, new Map([[a(2), 1n], [a(4), 1n]]));
    expect(c2.get(a(1))).toBe(500_000n);
    expect(c2.get(a(2))).toBe(300_050n);
    expect(c2.get(a(4))).toBe(50n);
  });

  it("never allocates more than the funded amount (floored shares)", () => {
    const w = new Map([[a(1), 1n], [a(2), 1n], [a(3), 1n]]);
    const c = addDistribution(new Map(), 100n, w);
    const t = buildDistributionTree(c, 4663n, DIST);
    expect(t.totalCumulative).toBe(99n);
    expect(t.totalCumulative).toBeLessThanOrEqual(100n);
  });

  it("leaf encoding matches WarchestDistributor.leaf (double keccak of abi.encode)", () => {
    const t = buildDistributionTree(new Map([[a(1), 5n], [a(2), 7n]]), 4663n, DIST);
    const expected = keccak256(keccak256(encodeAbiParameters(DIST_LEAF_TYPES.map((type) => ({ type })), [4663n, DIST, a(1), 5n])));
    expect(t.tree.leafHash([4663n, DIST, a(1), 5n])).toBe(expected);
    expect(t.tree.verify([4663n, DIST, a(2), 7n], t.tree.getProof([4663n, DIST, a(2), 7n]))).toBe(true);
  });

  it("is deterministic regardless of insertion order", () => {
    const x = buildDistributionTree(new Map([[a(1), 5n], [a(2), 7n]]), 1n, DIST);
    const y = buildDistributionTree(new Map([[a(2), 7n], [a(1), 5n]]), 1n, DIST);
    expect(x.root).toBe(y.root);
    expect(x.treeHash).toBe(y.treeHash);
  });
});
