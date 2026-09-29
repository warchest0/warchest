import { getAddress, isAddress, type Address } from "viem";
import { chainById } from "./chains";

/**
 * Build-time configuration. Next.js inlines `process.env.NEXT_PUBLIC_*` only when accessed literally, so every
 * variable is read by name below.
 */
function addr(v: string | undefined): Address | undefined {
  return v && isAddress(v) ? getAddress(v) : undefined;
}

function int(v: string | undefined, fallback: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

const chain = chainById(int(process.env.NEXT_PUBLIC_CHAIN_ID, 4663));

export const env = {
  /** Unsupported ids fall back to Robinhood Chain mainnet. */
  chainId: chain.id,
  chain,
  /** Optional RPC override (defaults to the chain's public RPC). */
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || undefined,
  governance: addr(process.env.NEXT_PUBLIC_GOVERNANCE),
  vault: addr(process.env.NEXT_PUBLIC_VAULT),
  token: addr(process.env.NEXT_PUBLIC_TOKEN),
  distributor: addr(process.env.NEXT_PUBLIC_DISTRIBUTOR),
  /** Weight tree JSON published by the indexer, `{epoch}` is replaced by the round's snapshot epoch. */
  treeUrlTemplate:
    process.env.NEXT_PUBLIC_TREE_URL_TEMPLATE ||
    (process.env.NEXT_PUBLIC_INDEXER_API ? `${process.env.NEXT_PUBLIC_INDEXER_API.replace(/\/+$/, "")}/trees/{epoch}` : ""),
  /**
   * Optional indexer HTTP API (`npm run indexer serve`). When set it serves the trees, per-account proofs and the
   * live lot book, so the app skips client-side log scans. Everything it returns is re-verified against the chain.
   */
  indexerApi: (process.env.NEXT_PUBLIC_INDEXER_API || "").replace(/\/+$/, ""),
  /** Cumulative distribution tree JSON (OZ StandardMerkleTree dump) for the distributor. */
  distributionTreeUrl: process.env.NEXT_PUBLIC_DISTRIBUTION_TREE_URL || "",
  /** First block to scan for events (deployment block). */
  startBlock: BigInt(int(process.env.NEXT_PUBLIC_START_BLOCK, 0)),
  /** Max block span per `eth_getLogs` request. */
  logChunk: BigInt(int(process.env.NEXT_PUBLIC_LOG_CHUNK, 50_000)),
  /** Force demo mode even when addresses are configured. */
  forceDemo: process.env.NEXT_PUBLIC_DEMO === "1",
} as const;

/** Demo mode is the default until governance and vault addresses are configured. */
export const isDemo = env.forceDemo || !env.governance || !env.vault;
