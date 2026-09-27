import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { snapshotAt } from "../src/snapshot.js";
import { buildWeightTree, proofFor } from "../src/tree.js";
import { GOVERNANCE_ABI, publishRoot, verifyRoot } from "../src/governance.js";
import { DAY, type Transfer } from "../src/types.js";

/**
 * End-to-end: trees built by the indexer are accepted by the REAL WarchestGovernance (compiled by Foundry) on anvil —
 * root submission, proofs, votes, quorum, decision. Skipped if anvil or the forge artifact is unavailable.
 */
const ARTIFACT = resolve(__dirname, "../../contracts/out/WarchestGovernance.sol/WarchestGovernance.json");
const hasAnvil = spawnSync("anvil", ["--version"]).status === 0;
const ready = hasAnvil && existsSync(ARTIFACT);

// anvil default keys
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const UPDATER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PORT = 8600 + Math.floor(Math.random() * 300);
const RPC = `http://127.0.0.1:${PORT}`;

const EXTRA_ABI = parseAbi([
  "function setEligibleAssets(uint32[] assets)",
  "function startDirectionRound(uint64 epoch) returns (uint256)",
  "function vote(uint256 roundId, uint256 option, uint256 weight, bytes32[] proof)",
  "function finalize(uint256 roundId)",
  "function currentDecision() view returns ((uint256 id, uint32 asset, uint8 side, uint256 roundId, uint64 decidedAt))",
  "function roundCount() view returns (uint256)",
]);

describe.skipIf(!ready)("indexer ↔ WarchestGovernance (anvil)", () => {
  let anvil: ChildProcess;
  let pub: PublicClient;
  let governance: Address;
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
  const voters = [1, 2, 3].map((i) => getAddress(`0x${i.toString(16).padStart(40, "0")}`));
  const POOL = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
  let publishedDay = 0;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "31337", "--silent"]);
    pub = createPublicClient({ chain: foundry, transport: http(RPC) }) as PublicClient;
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
    const w = createWalletClient({ account: DEPLOYER, chain: foundry, transport: http(RPC) });
    const hash = await w.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [DEPLOYER.address, UPDATER.address, { challengeWindow: 6n * 3600n, votingPeriod: 86400n, maxRootAge: 2n * 86400n, quorumBps: 1000 }],
    });
    governance = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    await w.writeContract({ address: governance, abi: EXTRA_ABI, functionName: "setEligibleAssets", args: [[0, 1, 5]] });
  }, 30_000);

  afterAll(() => anvil?.kill());

  it("publishes a root the contract accepts and voters can vote with indexer proofs", async () => {
    const now = Number((await pub.getBlock()).timestamp);
    const day = Math.floor(now / DAY) - 1; // yesterday: a complete day
    let n = 0;
    const t = (d: number, from: Address, to: Address, value: bigint): Transfer => ({
      blockNumber: BigInt(++n), logIndex: 0, txHash: "0x00", blockHash: "0x00", timestamp: d * DAY + 60, from, to, value,
    });
    const history = [
      t(day - 12, POOL, voters[0]!, 1_000n * 10n ** 18n), // level 10
      t(day - 3, POOL, voters[1]!, 2_000n * 10n ** 18n), // level 3
      t(day - 1, POOL, voters[2]!, 5_000n * 10n ** 18n), // level 1
    ];
    const snap = snapshotAt(history, day, [POOL]);
    publishedDay = day;
    expect(snap.weights.get(voters[0]!)).toBe(10_000n * 10n ** 18n);
    const tree = buildWeightTree(snap, 31337n, governance);

    // leaf encoding matches the contract bit for bit
    const onchainLeaf = await pub.readContract({ address: governance, abi: GOVERNANCE_ABI, functionName: "leaf", args: [BigInt(day), voters[0]!, 10_000n * 10n ** 18n] });
    expect(tree.tree.leafHash([31337n, governance, BigInt(day), voters[0]!, 10_000n * 10n ** 18n])).toBe(onchainLeaf);

    const updater = createWalletClient({ account: UPDATER, chain: foundry, transport: http(RPC) });
    await test.setBalance({ address: UPDATER.address, value: 10n ** 18n });
    const r = await publishRoot(pub, updater, governance, tree);
    expect(r.status).toBe("published");
    expect((await publishRoot(pub, updater, governance, tree)).status).toBe("skipped"); // idempotent
    expect(await verifyRoot(pub, governance, tree)).toEqual({ ok: true, problems: [] });

    // challenge window, then a round and votes with the indexer's proofs
    await test.increaseTime({ seconds: 6 * 3600 });
    await test.mine({ blocks: 1 });
    const anyone = createWalletClient({ account: DEPLOYER, chain: foundry, transport: http(RPC) });
    await pub.waitForTransactionReceipt({ hash: await anyone.writeContract({ address: governance, abi: EXTRA_ABI, functionName: "startDirectionRound", args: [BigInt(day)] }) });
    const roundId = await pub.readContract({ address: governance, abi: EXTRA_ABI, functionName: "roundCount" });

    for (const [i, option] of [[0, 3n], [1, 3n], [2, 0n]] as const) {
      const v = voters[i]!;
      const p = proofFor(tree, v)!;
      await test.impersonateAccount({ address: v });
      await test.setBalance({ address: v, value: 10n ** 18n });
      const vw = createWalletClient({ account: v, chain: foundry, transport: http(RPC) });
      const h = await vw.writeContract({ address: governance, abi: EXTRA_ABI, functionName: "vote", args: [roundId, option, p.weight, p.proof] });
      expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    }

    await test.increaseTime({ seconds: 86400 });
    await test.mine({ blocks: 1 });
    await pub.waitForTransactionReceipt({ hash: await anyone.writeContract({ address: governance, abi: EXTRA_ABI, functionName: "finalize", args: [roundId] }) });
    const d = await pub.readContract({ address: governance, abi: EXTRA_ABI, functionName: "currentDecision" });
    // voters 0+1 (10k + 6k) chose option 3 = ETH short over voter 2 (5k) → ETH (asset 1), Short
    expect(d.id).toBe(1n);
    expect(d.asset).toBe(1);
    expect(d.side).toBe(1);
  }, 60_000);

  it("the independent verifier flags a root that does not match the chain history", async () => {
    const day = publishedDay; // the epoch published by the previous test
    const forged = buildWeightTree(
      { day, weights: new Map([[voters[0]!, 1n]]), totalWeight: 1n, holders: 1 },
      31337n,
      governance,
    );
    const v = await verifyRoot(pub, governance, forged);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/root .* != expected/);
  });
});
