/**
 * Anvil harness: deploys the REAL `WarchestGovernance` and `WarchestVault` (Foundry artifacts) with the repo's mocks
 * (WETH, USDG, Uniswap v3 pool, Across SpokePool) and mints a governance decision through a single-leaf weight root.
 * Used by the integration tests of the chain reader and of the live executors. Skipped when anvil or the artifacts
 * are missing (CI builds the contracts first).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const OUT = resolve(__dirname, "../../contracts/out");
const artifact = (path: string) => {
  const p = resolve(OUT, path);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
};

export const ARTIFACTS = {
  governance: "WarchestGovernance.sol/WarchestGovernance.json",
  vault: "WarchestVault.sol/WarchestVault.json",
  weth: "MockWETH.sol/MockWETH.json",
  usdg: "MockUSDG.sol/MockUSDG.json",
  pool: "MockUniswapV3Pool.sol/MockUniswapV3Pool.json",
  spoke: "MockAcrossSpokePool.sol/MockAcrossSpokePool.json",
};

export const anvilReady = (): boolean =>
  spawnSync("anvil", ["--version"]).status === 0 && Object.values(ARTIFACTS).every((a) => existsSync(resolve(OUT, a)));

// anvil default accounts
export const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const UPDATER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const KEEPER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
export const VOTER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as const;
export const HL_ACCOUNT = getAddress("0x00000000000000000000000000000000000000A1");
export const USDC_HYPEREVM = getAddress("0xb88339CB7199b77E23DB6E890353E22632Ba630f");

export const GOV_EXTRA_ABI = parseAbi([
  "function setEligibleAssets(uint32[] assets)",
  "function setVault(address vault_)",
  "function submitWeightRoot(uint64 epoch, bytes32 root, uint256 totalWeight, bytes32 treeHash)",
  "function startDirectionRound(uint64 epoch) returns (uint256)",
  "function startCloseRound(uint64 epoch) returns (uint256)",
  "function vote(uint256 roundId, uint256 option, uint256 weight, bytes32[] proof)",
  "function finalize(uint256 roundId)",
  "function roundCount() view returns (uint256)",
  "function setPaused(bool paused_)",
]);
export const VAULT_EXTRA_ABI = parseAbi([
  "function setPaused(bool paused_)",
  "function setKeeper(address keeper_)",
  "function revokeCloseReport(uint256 decisionId)",
]);
export const MOCK_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function setTicks(int24 tick)",
  "function release(address token, address to, uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function numberOfDeposits() view returns (uint32)",
]);

/** ETH/USDG tick for `price` USDG per ETH (token0 = WETH 18 dec, token1 = USDG 6 dec). */
export const tickForPrice = (price: number): number => Math.round(Math.log((price * 1e6) / 1e18) / Math.log(1.0001));

export interface AnvilSystem {
  rpc: string;
  pub: PublicClient;
  governance: Address;
  vault: Address;
  weth: Address;
  usdg: Address;
  pool: Address;
  spoke: Address;
  keeper: Address;
  chainId: number;
  /** Advance chain time and mine a block. */
  warp(seconds: number): Promise<void>;
  /** Block timestamp of the latest block. */
  now(): Promise<number>;
  /** Mints a new quorate direction decision (asset 1 = ETH, long by default). Returns the decision id. */
  decide(option?: number): Promise<bigint>;
  /** Funds the vault with ETH and converts it with the keeper key so `usdgLedger` > 0. */
  fundAndConvert(eth: bigint): Promise<void>;
  /** Sends USDG from the mock SpokePool to the vault (simulates a bridge return / refund). */
  returnUsdg(amount: bigint): Promise<void>;
  /** Guardian (deployer) pauses / unpauses the vault. */
  pause(paused: boolean): Promise<void>;
  stop(): void;
}

export async function startAnvilSystem(opts: { chainId?: number; risk?: { stopLossBps: number; leverage: number; takeProfitBps: number } } = {}): Promise<AnvilSystem> {
  const chainId = opts.chainId ?? 31337;
  const port = 8700 + Math.floor(Math.random() * 500);
  const rpc = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--silent"]);
  const chain = { ...foundry, id: chainId };
  const pub = createPublicClient({ chain, transport: http(rpc) }) as PublicClient;
  const test = createTestClient({ chain, mode: "anvil", transport: http(rpc) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const updater = privateKeyToAccount(UPDATER_KEY);
  const keeperAcc = privateKeyToAccount(KEEPER_KEY);
  const voter = privateKeyToAccount(VOTER_KEY);
  const wallet = (account: typeof deployer) => createWalletClient({ account, chain, transport: http(rpc) });
  const w = wallet(deployer);

  const deploy = async (name: keyof typeof ARTIFACTS, args: unknown[] = []): Promise<Address> => {
    const a = artifact(ARTIFACTS[name])!;
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  };
  const write = async (account: typeof deployer, address: Address, abi: Abi, functionName: string, args: unknown[] = [], value?: bigint) => {
    const hash = await wallet(account).writeContract({ address, abi, functionName, args, value } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return r;
  };

  const weth = await deploy("weth");
  const usdg = await deploy("usdg");
  const pool = await deploy("pool", [weth, usdg]);
  const spoke = await deploy("spoke");
  const governance = await deploy("governance", [deployer.address, updater.address, { challengeWindow: 6n * 3600n, votingPeriod: 86_400n, maxRootAge: 2n * 86_400n, quorumBps: 1000 }]);
  const risk = opts.risk ?? { stopLossBps: 500, leverage: 3, takeProfitBps: 1000 };
  const vault = await deploy("vault", [
    deployer.address,
    keeperAcc.address,
    governance,
    "0x0000000000000000000000000000000000000000",
    { pool, weth, usdg },
    { spokePool: spoke, recipient: HL_ACCOUNT, outputToken: USDC_HYPEREVM, destinationChainId: 999n },
    { twapWindow: 1800, maxSlippageBps: 100, maxConvertPerCall: 50n * 10n ** 18n, convertCooldown: 600n },
    { capBps: 2000, maxBridgeFeeBps: 50, maxDecisionAge: 3n * 86_400n, stopLossBps: risk.stopLossBps, leverage: risk.leverage, takeProfitBps: risk.takeProfitBps, reportChallengeWindow: 6n * 3600n },
  ]);
  await write(deployer, governance, GOV_EXTRA_ABI, "setVault", [vault]);
  await write(deployer, governance, GOV_EXTRA_ABI, "setEligibleAssets", [[0, 1, 5]]);
  await write(deployer, pool, MOCK_ABI, "setTicks", [tickForPrice(2700)]);
  await write(deployer, usdg, MOCK_ABI, "mint", [pool, 10_000_000n * 10n ** 6n]);

  const now = async () => Number((await pub.getBlock()).timestamp);
  const warp = async (seconds: number) => {
    await test.increaseTime({ seconds });
    await test.mine({ blocks: 1 });
  };
  let lastEpoch = 0n;
  const decide = async (option = 2): Promise<bigint> => {
    // one voter holds the whole weight: root = leaf, empty proof
    const weight = 1_000_000n;
    const t = await now();
    let epoch = BigInt(Math.floor(t / 86_400));
    if (epoch <= lastEpoch) {
      await warp(86_400);
      epoch = lastEpoch + 1n;
    }
    lastEpoch = epoch;
    const leaf = keccak256(
      keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint64" }, { type: "address" }, { type: "uint256" }], [BigInt(chainId), governance, epoch, voter.address, weight])),
    );
    await write(updater, governance, GOV_EXTRA_ABI, "submitWeightRoot", [epoch, leaf, weight, leaf]);
    await warp(6 * 3600 + 1);
    await write(deployer, governance, GOV_EXTRA_ABI, "startDirectionRound", [epoch]);
    const roundId = await pub.readContract({ address: governance, abi: GOV_EXTRA_ABI, functionName: "roundCount" });
    await write(voter, governance, GOV_EXTRA_ABI, "vote", [roundId, BigInt(option), weight, []]);
    await warp(86_400 + 1);
    await write(deployer, governance, GOV_EXTRA_ABI, "finalize", [roundId]);
    const d = await pub.readContract({
      address: governance,
      abi: parseAbi(["function currentDecision() view returns ((uint256 id, uint32 asset, uint8 side, uint256 roundId, uint64 decidedAt))"]),
      functionName: "currentDecision",
    });
    return d.id;
  };
  const fundAndConvert = async (eth: bigint) => {
    await wallet(deployer).sendTransaction({ to: vault, value: eth });
    const floor = await pub.readContract({ address: vault, abi: parseAbi(["function twapFloor(uint256) view returns (uint256)"]), functionName: "twapFloor", args: [eth] });
    await write(keeperAcc, vault, parseAbi(["function convertEthToUsdg(uint256 amountIn, uint256 minOut) returns (uint256)"]), "convertEthToUsdg", [eth, floor]);
  };
  const returnUsdg = async (amount: bigint) => {
    const bal = await pub.readContract({ address: usdg, abi: MOCK_ABI, functionName: "balanceOf", args: [spoke] });
    if (bal < amount) await write(deployer, usdg, MOCK_ABI, "mint", [spoke, amount - bal]);
    await write(deployer, spoke, MOCK_ABI, "release", [usdg, vault, amount]);
  };

  const pause = async (paused: boolean) => {
    await write(deployer, vault, VAULT_EXTRA_ABI, "setPaused", [paused]);
  };

  return { rpc, pub, governance, vault, weth, usdg, pool, spoke, keeper: keeperAcc.address, chainId, warp, now, decide, fundAndConvert, returnUsdg, pause, stop: () => anvil.kill() };
}
