import { concat, encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";

/**
 * OpenZeppelin `StandardMerkleTree` dump (format "standard-v1"), as published by the indexer
 * (`indexer/src/tree.ts`). Weight tree leaves are `(chainid, governance, epoch, account, weight)`; distribution tree
 * leaves are `(chainid, distributor, account, cumulativeAmount)`. Proofs are computed here without the OZ library:
 * the dump already contains every node, so a proof is just the sibling path from the leaf to the root.
 */
export interface StandardTreeDump {
  format: "standard-v1";
  leafEncoding: string[];
  tree: Hex[];
  values: { value: (string | number)[]; treeIndex: number }[];
}

export const WEIGHT_LEAF_ENCODING = ["uint256", "address", "uint64", "address", "uint256"] as const;
export const DISTRIBUTION_LEAF_ENCODING = ["uint256", "address", "address", "uint256"] as const;

export interface WeightEntry {
  chainId: bigint;
  governance: Address;
  epoch: bigint;
  account: Address;
  weight: bigint;
  treeIndex: number;
}

export function parseTreeDump(json: unknown): StandardTreeDump {
  const d = json as Partial<StandardTreeDump> | null;
  if (!d || d.format !== "standard-v1" || !Array.isArray(d.tree) || !Array.isArray(d.values) || !Array.isArray(d.leafEncoding)) {
    throw new Error("not an OpenZeppelin StandardMerkleTree dump");
  }
  if (d.tree.length === 0) throw new Error("empty tree");
  return d as StandardTreeDump;
}

export function treeRoot(dump: StandardTreeDump): Hex {
  return dump.tree[0]!;
}

function siblingIndex(i: number): number {
  return i % 2 === 1 ? i + 1 : i - 1;
}

function parentIndex(i: number): number {
  return Math.floor((i - 1) / 2);
}

/** Sibling path from `treeIndex` up to the root (same order as OZ `getProof`). */
export function proofAt(dump: StandardTreeDump, treeIndex: number): Hex[] {
  if (treeIndex < 0 || treeIndex >= dump.tree.length) throw new Error(`tree index ${treeIndex} out of range`);
  const proof: Hex[] = [];
  let i = treeIndex;
  while (i > 0) {
    const s = dump.tree[siblingIndex(i)];
    if (s === undefined) throw new Error("malformed tree");
    proof.push(s);
    i = parentIndex(i);
  }
  return proof;
}

/** OZ standard leaf: `keccak256(bytes.concat(keccak256(abi.encode(...values))))`. */
export function standardLeaf(types: readonly string[], values: readonly unknown[]): Hex {
  const params = types.map((type) => ({ type }));
  return keccak256(keccak256(encodeAbiParameters(params, values as unknown[])));
}

/** Sorted-pair proof verification (OpenZeppelin `MerkleProof.verify`). */
export function verifyProof(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let h = leaf;
  for (const p of proof) {
    h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
  }
  return h.toLowerCase() === root.toLowerCase();
}

function sameEncoding(dump: StandardTreeDump, expected: readonly string[]): boolean {
  return dump.leafEncoding.length === expected.length && dump.leafEncoding.every((t, i) => t === expected[i]);
}

/** Every weight leaf of the tree, decoded. */
export function weightEntries(dump: StandardTreeDump): WeightEntry[] {
  if (!sameEncoding(dump, WEIGHT_LEAF_ENCODING)) throw new Error(`unexpected leaf encoding ${dump.leafEncoding.join(",")}`);
  return dump.values.map(({ value, treeIndex }) => {
    const [chainId, governance, epoch, account, weight] = value;
    if (!isAddress(String(account)) || !isAddress(String(governance))) throw new Error("malformed leaf");
    return {
      chainId: BigInt(chainId!),
      governance: getAddress(String(governance)),
      epoch: BigInt(epoch!),
      account: getAddress(String(account)),
      weight: BigInt(weight!),
      treeIndex,
    };
  });
}

export interface WeightProof {
  weight: bigint;
  proof: Hex[];
  leaf: Hex;
}

/**
 * Finds `account`'s weight and proof. Checks that the leaf is bound to the expected chain, governance and epoch,
 * and that the proof actually verifies against the dump's root, so the UI never submits a doomed transaction.
 */
export function findWeightProof(
  dump: StandardTreeDump,
  account: Address,
  expected?: { chainId?: number | bigint; governance?: Address; epoch?: number | bigint },
): WeightProof | undefined {
  const target = account.toLowerCase();
  const entry = weightEntries(dump).find((e) => e.account.toLowerCase() === target);
  if (!entry) return undefined;
  if (expected?.chainId !== undefined && entry.chainId !== BigInt(expected.chainId)) throw new Error("tree is for another chain");
  if (expected?.governance && entry.governance.toLowerCase() !== expected.governance.toLowerCase()) {
    throw new Error("tree is for another governance contract");
  }
  if (expected?.epoch !== undefined && entry.epoch !== BigInt(expected.epoch)) throw new Error("tree is for another epoch");
  const leaf = standardLeaf(WEIGHT_LEAF_ENCODING, [entry.chainId, entry.governance, entry.epoch, entry.account, entry.weight]);
  if (dump.tree[entry.treeIndex]?.toLowerCase() !== leaf.toLowerCase()) throw new Error("leaf does not match the tree");
  const proof = proofAt(dump, entry.treeIndex);
  if (!verifyProof(treeRoot(dump), leaf, proof)) throw new Error("proof does not verify");
  return { weight: entry.weight, proof, leaf };
}

export interface ClaimProof {
  cumulativeAmount: bigint;
  proof: Hex[];
}

/** Cumulative distribution entry for `account` (distributor tree). */
export function findClaimProof(dump: StandardTreeDump, account: Address): ClaimProof | undefined {
  if (!sameEncoding(dump, DISTRIBUTION_LEAF_ENCODING)) throw new Error(`unexpected leaf encoding ${dump.leafEncoding.join(",")}`);
  const target = account.toLowerCase();
  const found = dump.values.find((v) => String(v.value[2]).toLowerCase() === target);
  if (!found) return undefined;
  return { cumulativeAmount: BigInt(found.value[3]!), proof: proofAt(dump, found.treeIndex) };
}

/** Expands `NEXT_PUBLIC_TREE_URL_TEMPLATE` for a snapshot epoch. */
export function treeUrl(template: string, epoch: number | bigint): string {
  return template.replaceAll("{epoch}", String(epoch));
}
