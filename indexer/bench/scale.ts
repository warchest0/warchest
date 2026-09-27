// npm run bench — 100k holders benchmark (not part of CI).
import { getAddress, type Address, type Hex } from "viem";
import { snapshotAt } from "../src/snapshot.js";
import { buildWeightTree } from "../src/tree.js";
import { DAY, type Transfer } from "../src/types.js";

const POOL = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const holders = Number(process.argv[2] ?? 100_000);
const perHolder = Number(process.argv[3] ?? 5);
const out: Transfer[] = [];
let n = 0;
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
const wallets = Array.from({ length: holders }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`) as Address);
for (let k = 0; k < perHolder; k++)
  for (const w of wallets) {
    out.push({ blockNumber: BigInt(++n), logIndex: 0, txHash: "0x00" as Hex, blockHash: "0x00" as Hex, timestamp: Math.floor(((k * 30) / perHolder) * DAY), from: POOL, to: w, value: BigInt(1 + (rnd() % 1_000_000)) * 10n ** 12n });
    if (rnd() % 10 === 0) out.push({ ...out[out.length - 1]!, blockNumber: BigInt(++n), from: w, to: POOL, value: 1n });
  }
let t = performance.now();
const snap = snapshotAt(out, 40, [POOL]);
const s = performance.now() - t;
t = performance.now();
const tree = buildWeightTree(snap, 4663n, getAddress("0x00000000000000000000000000000000000060f0"));
const b = performance.now() - t;
console.log(JSON.stringify({ holders, transfers: out.length, snapshotMs: Math.round(s), treeMs: Math.round(b), dumpMB: +(tree.dump.length / 1e6).toFixed(1), heapMB: Math.round(process.memoryUsage().heapUsed / 1e6), depth: Math.ceil(Math.log2(holders)) }));
