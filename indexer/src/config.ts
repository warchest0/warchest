import { getAddress, type Address, type Hex } from "viem";

export interface Config {
  rpcUrl: string;
  chainId: bigint;
  token: Address;
  startBlock: bigint;
  governance: Address;
  /** Addresses that hold tokens but must never vote (PoolManager, vault, hook, distributor, governance, token…). */
  excluded: Address[];
  dbPath: string;
  outDir: string;
  /** Only the publishing instance has it; a verifier instance runs without. */
  updaterKey?: Hex;
}

const req = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const excluded = (env.EXCLUDED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => getAddress(a));
  const governance = getAddress(req(env, "GOVERNANCE"));
  const token = getAddress(req(env, "TOKEN"));
  return {
    rpcUrl: env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    chainId: BigInt(env.CHAIN_ID ?? "4663"),
    token,
    startBlock: BigInt(req(env, "START_BLOCK")),
    governance,
    // the protocol's own contracts are always excluded
    excluded: [...new Set([...excluded, governance, token, getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951")])],
    dbPath: env.DB_PATH ?? "data/indexer.sqlite",
    outDir: env.OUT_DIR ?? "data/trees",
    updaterKey: env.UPDATER_PRIVATE_KEY as Hex | undefined,
  };
}
