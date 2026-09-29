import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { createApi } from "../src/api.js";
import { snapshotAt } from "../src/snapshot.js";
import { Store } from "../src/store.js";
import { buildWeightTree } from "../src/tree.js";
import { DAY, type Transfer } from "../src/types.js";

const POOL = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const GOV = getAddress("0x00000000000000000000000000000000000060f0");
const A = getAddress("0x000000000000000000000000000000000000000a");
const B = getAddress("0x000000000000000000000000000000000000000b");
const EPOCH = 100;

let n = 0;
const tx = (day: number, from: Address, to: Address, value: bigint): Transfer => ({
  blockNumber: BigInt(++n), logIndex: 0, txHash: "0x00" as Hex, blockHash: "0x00" as Hex, timestamp: day * DAY + 60, from, to, value,
});

describe("indexer HTTP API", () => {
  let base = "";
  const server = (() => {
    const dir = mkdtempSync(join(tmpdir(), "trees-"));
    const history = [tx(90, POOL, A, 100n), tx(98, POOL, B, 50n)];
    const tree = buildWeightTree(snapshotAt(history, EPOCH, [POOL]), 4663n, GOV);
    writeFileSync(join(dir, `${EPOCH}.json`), tree.dump);
    const store = new Store();
    store.commit(history, 1n);
    return createApi({ treesDir: dir, store, excluded: [POOL], now: () => 103 * DAY + 10 });
  })();

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const get = async (path: string) => {
    const r = await fetch(base + path);
    return { status: r.status, body: await r.json(), cors: r.headers.get("access-control-allow-origin") };
  };

  it("health and epochs", async () => {
    expect((await get("/health")).body).toEqual({ ok: true, epochs: 1 });
    expect((await get("/epochs")).body).toEqual({ epochs: [EPOCH] });
  });

  it("serves a proof that matches the published tree", async () => {
    const r = await get(`/proof/${EPOCH}/${A.toLowerCase()}`);
    expect(r.status).toBe(200);
    expect(r.cors).toBe("*");
    expect(r.body.account).toBe(A);
    expect(r.body.weight).toBe("1000"); // 100 tokens held 10+ days → level 10
    expect(Array.isArray(r.body.proof)).toBe(true);
  });

  it("ranks holders by weight", async () => {
    const r = await get(`/leaderboard/${EPOCH}?limit=10`);
    expect(r.body.holders).toBe(2);
    expect(r.body.top[0]).toEqual({ rank: 1, account: A, weight: "1000" });
    expect(r.body.top[1]).toEqual({ rank: 2, account: B, weight: "100" }); // 50 × level 2
    expect(r.body.totalWeight).toBe("1100");
  });

  it("shows live lots, levels and next-level times", async () => {
    const r = await get(`/account/${B}`);
    expect(r.body.balance).toBe("50");
    expect(r.body.lots).toEqual([{ amount: "50", acquiredDay: 98, level: 5, nextLevelAt: 104 * DAY }]);
    expect(r.body.weight).toBe("250");
  });

  it("errors are explicit", async () => {
    expect((await get("/proof/999/" + A)).status).toBe(404);
    expect((await get("/proof/100/not-an-address")).status).toBe(400);
    expect((await get("/nope")).status).toBe(404);
  });
});
