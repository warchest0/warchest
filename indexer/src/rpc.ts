import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from "viem";
import type { ChainReader } from "./types.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** ChainReader over JSON-RPC (viem, batched requests). */
export class RpcChainReader implements ChainReader {
  readonly client: PublicClient;

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ transport: http(rpcUrl, { batch: { batchSize: 100 }, retryCount: 5 }) });
  }

  async finalizedBlock(): Promise<bigint> {
    const b = await this.client.getBlock({ blockTag: "finalized" });
    return b.number;
  }

  async transferLogs(token: Address, fromBlock: bigint, toBlock: bigint) {
    const logs = await this.client.getLogs({ address: token, event: TRANSFER, fromBlock, toBlock, strict: true });
    return logs.map((l) => ({
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      txHash: l.transactionHash,
      blockHash: l.blockHash,
      from: l.args.from,
      to: l.args.to,
      value: l.args.value,
    }));
  }

  async blockTimestamps(blocks: bigint[]): Promise<Map<bigint, number>> {
    const out = new Map<bigint, number>();
    const results = await Promise.all(blocks.map((n) => this.client.getBlock({ blockNumber: n })));
    for (const b of results) out.set(b.number, Number(b.timestamp));
    return out;
  }
}
