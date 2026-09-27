import { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import type { Transfer } from "./types.js";

/**
 * Append-only store of token transfers (SQLite, built into Node ≥ 24).
 * Values are stored as decimal strings to keep full uint256 precision.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS transfers (
        block_number INTEGER NOT NULL,
        log_index    INTEGER NOT NULL,
        tx_hash      TEXT NOT NULL,
        block_hash   TEXT NOT NULL,
        timestamp    INTEGER NOT NULL,
        sender       TEXT NOT NULL,
        recipient    TEXT NOT NULL,
        value        TEXT NOT NULL,
        PRIMARY KEY (block_number, log_index)
      );
      CREATE INDEX IF NOT EXISTS transfers_ts ON transfers (timestamp);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Last fully indexed block (inclusive), or undefined if nothing was indexed yet. */
  get cursor(): bigint | undefined {
    const v = this.getMeta("cursor");
    return v === undefined ? undefined : BigInt(v);
  }

  /** Inserts a batch of transfers and advances the cursor atomically. Re-inserting the same log is a no-op. */
  commit(transfers: Transfer[], cursor: bigint): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO transfers (block_number, log_index, tx_hash, block_hash, timestamp, sender, recipient, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const t of transfers) {
        insert.run(Number(t.blockNumber), t.logIndex, t.txHash, t.blockHash, t.timestamp, t.from.toLowerCase(), t.to.toLowerCase(), t.value.toString());
      }
      this.setMeta("cursor", cursor.toString());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** All transfers with `timestamp < before`, in chain order. */
  transfersBefore(before: number): Transfer[] {
    const rows = this.db
      .prepare("SELECT * FROM transfers WHERE timestamp < ? ORDER BY block_number, log_index")
      .all(before) as Record<string, string | number>[];
    return rows.map((r) => ({
      blockNumber: BigInt(r.block_number as number),
      logIndex: r.log_index as number,
      txHash: r.tx_hash as Hex,
      blockHash: r.block_hash as Hex,
      timestamp: r.timestamp as number,
      from: r.sender as Address,
      to: r.recipient as Address,
      value: BigInt(r.value as string),
    }));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM transfers").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
