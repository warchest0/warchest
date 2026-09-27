import type { Address, Hex } from "viem";

/** One ERC20 Transfer of the WARCHEST token, as stored by the indexer. */
export interface Transfer {
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  blockHash: Hex;
  /** Block timestamp in seconds (Robinhood Chain logs do not carry it: fetched per block). */
  timestamp: number;
  from: Address;
  to: Address;
  value: bigint;
}

/** Minimal chain access, so ingestion can be tested without an RPC. */
export interface ChainReader {
  /** Highest block considered irreversible (the `finalized` tag on Robinhood Chain). */
  finalizedBlock(): Promise<bigint>;
  /** Transfer logs of `token` in [fromBlock, toBlock], WITHOUT timestamps. */
  transferLogs(token: Address, fromBlock: bigint, toBlock: bigint): Promise<Omit<Transfer, "timestamp">[]>;
  /** Timestamps (seconds) of the given blocks. */
  blockTimestamps(blocks: bigint[]): Promise<Map<bigint, number>>;
}

export const DAY = 86_400;

/** UTC day index of a timestamp — the governance `epoch`. */
export const dayOf = (timestamp: number): number => Math.floor(timestamp / DAY);
