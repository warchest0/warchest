import type { AbiEvent, Address, Hex, PublicClient } from "viem";

/**
 * Backward log scanner. The dapp has no indexer of its own, so event history is read straight from the RPC in
 * bounded chunks, newest first, until enough events are found, the deployment block is reached, or the chunk
 * budget is spent. Good enough for a transparency page; a subgraph can replace it later behind the same provider.
 */
export interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface ScanOptions {
  address: Address;
  events: readonly AbiEvent[];
  args?: Record<string, unknown>;
  fromBlock: bigint;
  chunk: bigint;
  /** Stop once this many logs are collected. */
  limit?: number;
  maxChunks?: number;
  /** Stop when a chunk starts before this timestamp (checked with one `getBlock` per chunk). */
  sinceTimestamp?: number;
}

export async function scanBackward(client: PublicClient, o: ScanOptions): Promise<DecodedLog[]> {
  const head = await client.getBlockNumber();
  const out: DecodedLog[] = [];
  let to = head;
  const maxChunks = o.maxChunks ?? 40;
  for (let i = 0; i < maxChunks && to >= o.fromBlock; i++) {
    const from = to - o.chunk + 1n > o.fromBlock ? to - o.chunk + 1n : o.fromBlock;
    const logs = (await client.getLogs({
      address: o.address,
      events: o.events,
      args: o.args,
      fromBlock: from,
      toBlock: to,
      strict: true,
    } as Parameters<PublicClient["getLogs"]>[0])) as unknown as DecodedLog[];
    out.unshift(...logs);
    if (o.limit && out.length >= o.limit) break;
    if (o.sinceTimestamp !== undefined) {
      const b = await client.getBlock({ blockNumber: from });
      if (Number(b.timestamp) < o.sinceTimestamp) break;
    }
    if (from === o.fromBlock) break;
    to = from - 1n;
  }
  return out;
}

/**
 * Block timestamps. Robinhood Chain's `eth_getLogs` returns `blockTimestamp = 0x0` (see indexer README), so they
 * are fetched per block (batched by the HTTP transport).
 */
export async function blockTimestamps(client: PublicClient, blocks: readonly bigint[]): Promise<Map<bigint, number>> {
  const unique = [...new Set(blocks)];
  const res = await Promise.all(unique.map((n) => client.getBlock({ blockNumber: n })));
  return new Map(res.map((b) => [b.number, Number(b.timestamp)]));
}
