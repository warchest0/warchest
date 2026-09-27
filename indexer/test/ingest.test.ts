import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { ingest } from "../src/ingest.js";
import { Store } from "../src/store.js";
import { FakeChain } from "./fakeChain.js";

const TOKEN = "0x00000000000000000000000000000000000000aa" as Address;
const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("ingest", () => {
  it("indexes from the start block up to finalized, in chunks, with timestamps", async () => {
    const chain = new FakeChain();
    chain.push(100n, 1_000, ZERO, A, 1000n);
    chain.push(150n, 1_010, A, B, 10n);
    chain.push(399n, 1_020, B, A, 1n);
    const store = new Store();
    const r = await ingest(chain, store, { token: TOKEN, startBlock: 100n, chunkSize: 100n });
    expect(r).toEqual({ fromBlock: 100n, toBlock: 399n, transfers: 3 });
    expect(chain.getLogsCalls).toEqual([[100n, 199n], [200n, 299n], [300n, 399n]]);
    expect(store.cursor).toBe(399n);
    const all = store.transfersBefore(Number.MAX_SAFE_INTEGER);
    expect(all.map((t) => t.timestamp)).toEqual([1_000, 1_010, 1_020]);
    expect(all[1]!.value).toBe(10n);
  });

  it("is incremental and idempotent", async () => {
    const chain = new FakeChain();
    chain.push(10n, 1, ZERO, A, 5n);
    const store = new Store();
    await ingest(chain, store, { token: TOKEN, startBlock: 1n });
    expect(await ingest(chain, store, { token: TOKEN, startBlock: 1n })).toBeUndefined();
    chain.push(20n, 2, A, B, 1n);
    const r = await ingest(chain, store, { token: TOKEN, startBlock: 1n });
    expect(r).toEqual({ fromBlock: 11n, toBlock: 20n, transfers: 1 });
    expect(store.count()).toBe(2);
  });

  it("never indexes past the finalized block", async () => {
    const chain = new FakeChain();
    chain.push(10n, 1, ZERO, A, 5n);
    chain.push(30n, 3, A, B, 1n);
    chain.finalized = 20n; // block 30 not final yet
    const store = new Store();
    await ingest(chain, store, { token: TOKEN, startBlock: 1n });
    expect(store.count()).toBe(1);
    expect(store.cursor).toBe(20n);
  });

  it("keeps full uint256 precision", async () => {
    const chain = new FakeChain();
    const big = 2n ** 255n + 12345n;
    chain.push(1n, 1, ZERO, A, big);
    const store = new Store();
    await ingest(chain, store, { token: TOKEN, startBlock: 1n });
    expect(store.transfersBefore(10)[0]!.value).toBe(big);
  });

  it("does not advance the cursor when a chunk fails", async () => {
    const chain = new FakeChain();
    chain.push(10n, 1, ZERO, A, 5n);
    chain.blockTimestamps = async () => new Map(); // missing timestamps
    const store = new Store();
    await expect(ingest(chain, store, { token: TOKEN, startBlock: 1n })).rejects.toThrow(/missing timestamp/);
    expect(store.cursor).toBeUndefined();
    expect(store.count()).toBe(0);
  });
});
