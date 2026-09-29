import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, isAddress, type Address } from "viem";
import { LotBook } from "./lots.js";
import type { Store } from "./store.js";
import { DAY, dayOf } from "./types.js";

/**
 * Read-only HTTP API for the frontend. No dependencies, JSON only, CORS open (public data).
 *
 *   GET /health
 *   GET /epochs                          published tree days, newest first
 *   GET /trees/:epoch                    the published tree dump (OZ StandardMerkleTree format)
 *   GET /proof/:epoch/:account           { epoch, account, weight, proof } to pass to WarchestGovernance.vote
 *   GET /leaderboard/:epoch?limit=100    holders ranked by weight
 *   GET /account/:account                live lots, levels, balance and weight at the current UTC day
 */
export interface ApiOptions {
  /** Directory with `<epoch>.json` tree dumps (the indexer's OUT_DIR). */
  treesDir: string;
  /** Transfer store, for live account views. Optional: without it `/account` answers 503. */
  store?: Store;
  /** Addresses that never hold lots (same list as the snapshots). */
  excluded?: Address[];
  /** Clock, injectable for tests (seconds). */
  now?: () => number;
}

type TreeValue = [string, string, string, string, string];

interface LoadedTree {
  tree: StandardMerkleTree<TreeValue>;
  dump: string;
}

export function createApi(opts: ApiOptions): Server {
  const cache = new Map<number, LoadedTree>();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const epochs = (): number[] =>
    existsSync(opts.treesDir)
      ? readdirSync(opts.treesDir)
          .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
          .filter((d): d is string => d !== undefined)
          .map(Number)
          .sort((a, b) => b - a)
      : [];

  const loadTree = (epoch: number): LoadedTree | undefined => {
    const hit = cache.get(epoch);
    if (hit) return hit;
    const file = join(opts.treesDir, `${epoch}.json`);
    if (!existsSync(file)) return undefined;
    const dump = readFileSync(file, "utf8");
    const loaded = { tree: StandardMerkleTree.load<TreeValue>(JSON.parse(dump)), dump };
    cache.set(epoch, loaded);
    return loaded;
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const [route, a, b] = parts;

    if (route === "health") return send(res, 200, { ok: true, epochs: epochs().length });
    if (route === "epochs") return send(res, 200, { epochs: epochs() });

    if (route === "trees" && a) {
      const t = loadTree(Number(a));
      if (!t) return send(res, 404, { error: `no tree for epoch ${a}` });
      res.statusCode = 200;
      res.setHeader("cache-control", "public, max-age=3600, immutable");
      res.end(t.dump);
      return;
    }

    if (route === "proof" && a && b) {
      if (!isAddress(b)) return send(res, 400, { error: "invalid address" });
      const t = loadTree(Number(a));
      if (!t) return send(res, 404, { error: `no tree for epoch ${a}` });
      for (const [i, v] of t.tree.entries()) {
        if (v[3].toLowerCase() === b.toLowerCase()) {
          return send(res, 200, { epoch: Number(a), account: getAddress(b), weight: String(v[4]), proof: t.tree.getProof(i) });
        }
      }
      return send(res, 404, { error: "account has no weight in this epoch" });
    }

    if (route === "leaderboard" && a) {
      const t = loadTree(Number(a));
      if (!t) return send(res, 404, { error: `no tree for epoch ${a}` });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
      const rows = [...t.tree.entries()].map(([, v]) => ({ account: getAddress(v[3]), weight: BigInt(v[4]) }));
      const total = rows.reduce((s, r) => s + r.weight, 0n);
      rows.sort((x, y) => (y.weight > x.weight ? 1 : y.weight < x.weight ? -1 : 0));
      return send(res, 200, {
        epoch: Number(a),
        holders: rows.length,
        totalWeight: String(total),
        top: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, account: r.account, weight: String(r.weight) })),
      });
    }

    if (route === "account" && a) {
      if (!isAddress(a)) return send(res, 400, { error: "invalid address" });
      if (!opts.store) return send(res, 503, { error: "live account view disabled (no store)" });
      const today = dayOf(now());
      const book = new LotBook(opts.excluded ?? []);
      for (const t of opts.store.transfersBefore((today + 1) * DAY)) book.apply(t);
      const lots = book.lotsOf(a).map((l) => {
        const level = LotBook.level(l, today);
        return { amount: String(l.amount), acquiredDay: l.day, level, nextLevelAt: level < 10 ? (l.day + level + 1) * DAY : null };
      });
      const weight = book.lotsOf(a).reduce((s, l) => s + l.amount * BigInt(LotBook.level(l, today)), 0n);
      return send(res, 200, { account: getAddress(a), day: today, balance: String(book.balanceOf(a)), weight: String(weight), lots });
    }

    send(res, 404, { error: "not found" });
  };

  return createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      send(res, 500, { error: e instanceof Error ? e.message : "internal error" });
    }
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
