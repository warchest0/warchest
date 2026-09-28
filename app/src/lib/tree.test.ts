import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_LEAF_ENCODING,
  WEIGHT_LEAF_ENCODING,
  findClaimProof,
  findWeightProof,
  parseTreeDump,
  treeRoot,
  treeUrl,
  weightEntries,
} from "./tree";

const GOV = getAddress("0x00000000000000000000000000000000000000aa");
const accounts: Address[] = Array.from({ length: 9 }, (_, i) =>
  getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`),
);

/** Builds a dump exactly like the indexer does (`indexer/src/tree.ts`). */
function indexerDump(epoch: number) {
  const values = accounts.map((a, i) => [4663n, GOV, BigInt(epoch), a, BigInt((i + 1) * 1000)] as const);
  const tree = StandardMerkleTree.of(
    values.map((v) => [...v]),
    [...WEIGHT_LEAF_ENCODING],
    { sortLeaves: true },
  );
  const json = JSON.parse(JSON.stringify(tree.dump(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return { tree, json };
}

describe("weight tree proof lookup", () => {
  const { tree, json } = indexerDump(20_000);
  const dump = parseTreeDump(json);

  it("reads the root and every entry", () => {
    expect(treeRoot(dump)).toBe(tree.root);
    expect(weightEntries(dump)).toHaveLength(accounts.length);
  });

  it("returns the same proof as the OpenZeppelin library, for every account", () => {
    for (const [i, v] of tree.entries()) {
      const account = v[3] as Address;
      const found = findWeightProof(dump, account, { chainId: 4663, governance: GOV, epoch: 20_000 });
      expect(found?.weight).toBe(BigInt(v[4] as bigint));
      expect(found?.proof).toEqual(tree.getProof(i) as Hex[]);
      expect(tree.verify(v, found!.proof)).toBe(true);
    }
  });

  it("is case-insensitive on the account", () => {
    expect(findWeightProof(dump, accounts[3]!.toLowerCase() as Address)?.weight).toBe(4000n);
  });

  it("returns undefined for a non-holder and rejects a mismatched tree", () => {
    expect(findWeightProof(dump, getAddress("0x00000000000000000000000000000000000000ff"))).toBeUndefined();
    expect(() => findWeightProof(dump, accounts[0]!, { epoch: 1 })).toThrow(/epoch/);
    expect(() => findWeightProof(dump, accounts[0]!, { chainId: 46630 })).toThrow(/chain/);
  });

  it("rejects a tampered dump", () => {
    const bad = structuredClone(json);
    const target = bad.values.find((v: { value: string[] }) => v.value[3] === accounts[0]);
    target.value[4] = "999999";
    expect(() => findWeightProof(parseTreeDump(bad), accounts[0]!)).toThrow();
    expect(() => parseTreeDump({ format: "nope" })).toThrow();
  });

  it("expands the URL template", () => {
    expect(treeUrl("https://x.io/trees/{epoch}.json", 20_001)).toBe("https://x.io/trees/20001.json");
  });
});

describe("distribution tree proof lookup", () => {
  it("matches the OpenZeppelin library", () => {
    const DIST = getAddress("0x00000000000000000000000000000000000000bb");
    const values = accounts.slice(0, 5).map((a, i) => [4663n, DIST, a, BigInt(i * 7 + 1)]);
    const tree = StandardMerkleTree.of(values, [...DISTRIBUTION_LEAF_ENCODING], { sortLeaves: true });
    const dump = parseTreeDump(JSON.parse(JSON.stringify(tree.dump(), (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
    for (const [i, v] of tree.entries()) {
      const found = findClaimProof(dump, v[2] as Address);
      expect(found?.cumulativeAmount).toBe(v[3]);
      expect(found?.proof).toEqual(tree.getProof(i));
    }
  });
});
