import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";
import { publishRoot, verifyRoot } from "./governance.js";
import { ingest } from "./ingest.js";
import { RpcChainReader } from "./rpc.js";
import { snapshotAt } from "./snapshot.js";
import { Store } from "./store.js";
import { buildWeightTree } from "./tree.js";
import { DAY, dayOf } from "./types.js";

/**
 * Usage (env: see src/config.ts):
 *   indexer sync               index finalized transfers
 *   indexer snapshot [day]     build + write the tree of a day (default: latest complete day)
 *   indexer publish [day]      snapshot + submit the root (needs UPDATER_PRIVATE_KEY)
 *   indexer verify [day]       rebuild and compare with the on-chain root (independent verifier instance)
 *   indexer run                sync + publish latest complete day (cron entry point, daily after 00:15 UTC)
 */
async function main(): Promise<void> {
  const [cmd = "run", dayArg] = process.argv.slice(2);
  const cfg = loadConfig();
  mkdirSync(join(cfg.dbPath, ".."), { recursive: true });
  mkdirSync(cfg.outDir, { recursive: true });
  const store = new Store(cfg.dbPath);
  const chain = new RpcChainReader(cfg.rpcUrl);

  const sync = async () => {
    const r = await ingest(chain, store, { token: cfg.token, startBlock: cfg.startBlock });
    console.log(r ? `synced blocks ${r.fromBlock}..${r.toBlock}: ${r.transfers} transfers` : "already up to date");
  };

  /** Latest UTC day fully covered by finalized blocks. */
  const latestCompleteDay = async () => {
    const fin = await chain.client.getBlock({ blockTag: "finalized" });
    return dayOf(Number(fin.timestamp)) - 1;
  };

  const build = async (day: number) => {
    const snap = snapshotAt(store.transfersBefore((day + 1) * DAY), day, cfg.excluded);
    const tree = buildWeightTree(snap, cfg.chainId, cfg.governance);
    const file = join(cfg.outDir, `${day}.json`);
    writeFileSync(file, tree.dump);
    console.log(`day ${day}: ${snap.weights.size} voters, totalWeight ${snap.totalWeight}, root ${tree.root}, treeHash ${tree.treeHash} → ${file}`);
    return tree;
  };

  const dayOrLatest = async () => (dayArg !== undefined ? Number(dayArg) : latestCompleteDay());

  switch (cmd) {
    case "sync":
      await sync();
      break;
    case "snapshot":
      await sync();
      await build(await dayOrLatest());
      break;
    case "publish":
    case "run": {
      if (!cfg.updaterKey) throw new Error("UPDATER_PRIVATE_KEY required to publish");
      await sync();
      const tree = await build(await dayOrLatest());
      const chainDef = defineChain({ id: Number(cfg.chainId), name: "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
      const wallet = createWalletClient({ account: privateKeyToAccount(cfg.updaterKey), chain: chainDef, transport: http(cfg.rpcUrl) });
      console.log(await publishRoot(chain.client, wallet, cfg.governance, tree));
      break;
    }
    case "verify": {
      await sync();
      const tree = await build(await dayOrLatest());
      const v = await verifyRoot(chain.client, cfg.governance, tree);
      console.log(v.ok ? "OK: on-chain root matches the chain history" : `MISMATCH — escalate to the guardian:\n${v.problems.join("\n")}`);
      process.exitCode = v.ok ? 0 : 2;
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
