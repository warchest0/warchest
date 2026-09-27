import type { Address } from "viem";
import type { ChainReader, Transfer } from "./types.js";
import type { Store } from "./store.js";

export interface IngestOptions {
  token: Address;
  /** Token deployment block: indexing starts here the first time. */
  startBlock: bigint;
  /** Max blocks per getLogs call (RPC limit). */
  chunkSize?: bigint;
}

export interface IngestResult {
  fromBlock: bigint;
  toBlock: bigint;
  transfers: number;
}

/**
 * Indexes Transfer logs up to the `finalized` block only. Finalized blocks cannot reorg, so no rollback logic is
 * needed; each chunk is committed atomically together with the cursor, so a crash never leaves a gap or a duplicate.
 * Returns undefined when already up to date.
 */
export async function ingest(chain: ChainReader, store: Store, opts: IngestOptions): Promise<IngestResult | undefined> {
  const chunk = opts.chunkSize ?? 10_000n;
  const target = await chain.finalizedBlock();
  const first = store.cursor === undefined ? opts.startBlock : store.cursor + 1n;
  if (first > target) return undefined;

  let total = 0;
  for (let from = first; from <= target; from += chunk) {
    const to = from + chunk - 1n < target ? from + chunk - 1n : target;
    const logs = await chain.transferLogs(opts.token, from, to);
    const blocks = [...new Set(logs.map((l) => l.blockNumber))];
    const ts = blocks.length ? await chain.blockTimestamps(blocks) : new Map<bigint, number>();
    const transfers: Transfer[] = logs.map((l) => {
      const timestamp = ts.get(l.blockNumber);
      if (timestamp === undefined) throw new Error(`missing timestamp for block ${l.blockNumber}`);
      return { ...l, timestamp };
    });
    store.commit(transfers, to);
    total += transfers.length;
  }
  return { fromBlock: first, toBlock: target, transfers: total };
}
