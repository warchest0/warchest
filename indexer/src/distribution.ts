import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";

/** Leaf encoding shared with `WarchestDistributor.leaf`: (chainid, distributor, account, cumulativeAmount). */
export const DIST_LEAF_TYPES = ["uint256", "address", "address", "uint256"] as const;
type DistLeaf = [bigint, Address, Address, bigint];

export interface DistributionTree {
  root: Hex;
  /** Σ cumulative entitlements — passed as `totalCumulative` to `proposeRoot` (must be ≤ distributor.totalFunded). */
  totalCumulative: bigint;
  cumulative: Map<Address, bigint>;
  treeHash: Hex;
  dump: string;
  tree: StandardMerkleTree<DistLeaf>;
}

/**
 * Adds one funding round to the cumulative entitlements, split pro-rata to the snapshot weights (Σ lot × level).
 * Shares are floored: the rounding dust (< number of holders, in USDG base units) stays unallocated, so the tree
 * total can never exceed what the distributor actually received.
 */
export function addDistribution(
  previous: ReadonlyMap<Address, bigint>,
  amount: bigint,
  weights: ReadonlyMap<Address, bigint>,
): Map<Address, bigint> {
  let total = 0n;
  for (const w of weights.values()) total += w;
  if (total === 0n) throw new Error("no weight to distribute to");
  const next = new Map(previous);
  for (const [account, w] of weights) {
    const share = (amount * w) / total;
    if (share > 0n) next.set(account, (next.get(account) ?? 0n) + share);
  }
  return next;
}

export function buildDistributionTree(cumulative: ReadonlyMap<Address, bigint>, chainId: bigint, distributor: Address): DistributionTree {
  const entries = [...cumulative.entries()].filter(([, v]) => v > 0n).sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  if (entries.length === 0) throw new Error("empty distribution");
  const values: DistLeaf[] = entries.map(([a, v]) => [chainId, distributor, a, v]);
  const tree = StandardMerkleTree.of(values, [...DIST_LEAF_TYPES], { sortLeaves: true });
  const dump = JSON.stringify(tree.dump(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return {
    root: tree.root as Hex,
    totalCumulative: entries.reduce((s, [, v]) => s + v, 0n),
    cumulative: new Map(entries),
    treeHash: keccak256(stringToBytes(dump)),
    dump,
    tree,
  };
}
