import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import type { Snapshot } from "./snapshot.js";

/**
 * Leaf encoding shared with `WarchestGovernance.leaf`:
 * `keccak256(bytes.concat(keccak256(abi.encode(chainid, governance, epoch, account, weight))))`,
 * sorted-pair tree — exactly OpenZeppelin's StandardMerkleTree.
 */
export const LEAF_TYPES = ["uint256", "address", "uint64", "address", "uint256"] as const;
type LeafValue = [bigint, Address, bigint, Address, bigint];

export interface WeightTree {
  chainId: bigint;
  governance: Address;
  epoch: number;
  root: Hex;
  totalWeight: bigint;
  /** keccak256 of the canonical JSON dump: published on-chain so anyone can check the file they download. */
  treeHash: Hex;
  /** Canonical JSON (OZ StandardMerkleTree dump), to publish for voters and verifiers. */
  dump: string;
  tree: StandardMerkleTree<LeafValue>;
}

export function buildWeightTree(snapshot: Snapshot, chainId: bigint, governance: Address): WeightTree {
  // sorted by address so the dump (and its hash) is deterministic whatever the Map iteration order was
  const entries = [...snapshot.weights.entries()].sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  if (entries.length === 0) throw new Error(`snapshot ${snapshot.day} has no weight`);
  const values: LeafValue[] = entries.map(([account, weight]) => [chainId, governance, BigInt(snapshot.day), account, weight]);
  const tree = StandardMerkleTree.of(values, [...LEAF_TYPES], { sortLeaves: true });
  const dump = JSON.stringify(tree.dump(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return {
    chainId,
    governance,
    epoch: snapshot.day,
    root: tree.root as Hex,
    totalWeight: snapshot.totalWeight,
    treeHash: keccak256(stringToBytes(dump)),
    dump,
    tree,
  };
}

/** Proof + weight a voter passes to `WarchestGovernance.vote`. */
export function proofFor(t: WeightTree, account: Address): { weight: bigint; proof: Hex[] } | undefined {
  for (const [i, v] of t.tree.entries()) {
    if (v[3].toLowerCase() === account.toLowerCase()) return { weight: BigInt(v[4]), proof: t.tree.getProof(i) as Hex[] };
  }
  return undefined;
}
