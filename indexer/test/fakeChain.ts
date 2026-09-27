import type { Address, Hex } from "viem";
import type { ChainReader, Transfer } from "../src/types.js";

/** In-memory chain: transfers are pushed with explicit block numbers and timestamps. */
export class FakeChain implements ChainReader {
  finalized = 0n;
  readonly transfers: Transfer[] = [];
  getLogsCalls: [bigint, bigint][] = [];
  private logIndex = 0;

  push(block: bigint, timestamp: number, from: Address, to: Address, value: bigint): void {
    this.transfers.push({
      blockNumber: block,
      logIndex: this.logIndex++,
      txHash: `0x${"a".repeat(64)}` as Hex,
      blockHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
      timestamp,
      from,
      to,
      value,
    });
    if (block > this.finalized) this.finalized = block;
  }

  async finalizedBlock() {
    return this.finalized;
  }

  async transferLogs(_token: Address, fromBlock: bigint, toBlock: bigint) {
    this.getLogsCalls.push([fromBlock, toBlock]);
    return this.transfers
      .filter((t) => t.blockNumber >= fromBlock && t.blockNumber <= toBlock)
      .map(({ timestamp: _ts, ...rest }) => rest);
  }

  async blockTimestamps(blocks: bigint[]) {
    const m = new Map<bigint, number>();
    for (const t of this.transfers) if (blocks.includes(t.blockNumber)) m.set(t.blockNumber, t.timestamp);
    return m;
  }
}
