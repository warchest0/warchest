import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { snapshotAt } from "../src/snapshot.js";
import { buildWeightTree, proofFor } from "../src/tree.js";
import { DAY, type Transfer } from "../src/types.js";

const POOL = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const GOV = getAddress("0x00000000000000000000000000000000000060f0");

/** Synthetic history: `holders` wallets, `perHolder` buys each over 30 days, ~10% partial sells. */
function synthetic(holders: number, perHolder: number): Transfer[] {
  const out: Transfer[] = [];
  let n = 0;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const wallets = Array.from({ length: holders }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`) as Address);
  for (let k = 0; k < perHolder; k++) {
    for (const w of wallets) {
      const day = (k * 30) / perHolder;
      out.push({ blockNumber: BigInt(++n), logIndex: 0, txHash: "0x00" as Hex, blockHash: "0x00" as Hex, timestamp: Math.floor(day * DAY) + (rnd() % 3600), from: POOL, to: w, value: BigInt(1 + (rnd() % 1_000_000)) * 10n ** 12n });
      if (rnd() % 10 === 0) out.push({ ...out[out.length - 1]!, blockNumber: BigInt(++n), from: w, to: POOL, value: 1n });
    }
  }
  return out.sort((x, y) => x.timestamp - y.timestamp || Number(x.blockNumber - y.blockNumber));
}

describe("scale (S4.4)", () => {
  it("10k holders × 5 buys: snapshot + tree + proofs in seconds", () => {
    const history = synthetic(10_000, 5);
    let t0 = performance.now();
    const snap = snapshotAt(history, 40, [POOL]);
    const snapMs = performance.now() - t0;
    t0 = performance.now();
    const tree = buildWeightTree(snap, 4663n, GOV);
    const treeMs = performance.now() - t0;
    console.log(`10k holders, ${history.length} transfers: snapshot ${snapMs.toFixed(0)} ms, tree ${treeMs.toFixed(0)} ms, depth ≈ ${Math.ceil(Math.log2(snap.weights.size))}`);
    expect(snap.weights.size).toBe(10_000);
    const p = proofFor(tree, getAddress("0x0000000000000000000000000000000000000001"))!;
    expect(p.proof.length).toBeLessThanOrEqual(14);
    expect(snapMs + treeMs).toBeLessThan(30_000);
  }, 120_000);
});
