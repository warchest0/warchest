import { DatabaseSync } from "node:sqlite";

/**
 * Keeper lifecycle of one vault position (one governance decision). Persisted so that a restart resumes exactly where
 * it stopped; every transition is re-validated against the chain and Hyperliquid before acting.
 */
export type Stage =
  | "bridging" // executeDecision sent; waiting for the Across fill
  | "funding" // USDC on HyperEVM; waiting for the multisig to move it to HyperCore / the trading account
  | "opening" // entry order(s) being placed
  | "protecting" // stop-loss / take-profit being placed and verified
  | "holding" // protected position; periodic equity reports; watching mustClose
  | "closing" // reduce-only exit in progress
  | "closed_on_hl" // flat on Hyperliquid; multisig must send the funds back
  | "awaiting_return" // return instructions issued; waiting for USDG on the vault
  | "report_closed" // reportClosed sent; waiting for the challenge window
  | "finalized"; // finalizeClose sent (or done by someone else)

export interface Run {
  decisionId: bigint;
  stage: Stage;
  data: RunData;
  updatedAt: number;
}

/** Free-form facts accumulated during a run (all optional, all JSON-serialisable). */
export interface RunData {
  asset?: number;
  coin?: string;
  side?: "long" | "short";
  capital?: string;
  outputAmount?: string;
  depositId?: string;
  /** Across fill deadline of the outbound deposit (seconds). */
  fillDeadline?: number;
  executeTxHash?: string;
  bridgeFilledAt?: number;
  /** Entry attempts already made (cloids are derived from this counter: idempotent across restarts). */
  entryAttempts?: number;
  entryOids?: number[];
  filledSize?: string;
  avgEntryPx?: string;
  /** Protection attempts already made (cloids derived from it). */
  protectAttempts?: number;
  stopLossOid?: number;
  takeProfitOid?: number;
  stopLossPx?: string;
  takeProfitPx?: string;
  lastReportAt?: number;
  lastReportedEquity?: string;
  closeReason?: string;
  closedOnHlAt?: number;
  /** True when the decision was closed before any position was opened: the bridged USDC must come back in full. */
  noTrade?: boolean;
  /** Equity (USDC, 6 decimals) at the time the position was closed on Hyperliquid = the return expected in the vault. */
  finalEquity?: string;
  returnPlanIssuedAt?: number;
  /** Text of the return plan issued to the multisig. */
  returnPlan?: string;
  returnTxHashes?: string[];
  reportClosedTxHash?: string;
  reportClosedAt?: number;
  finalizeTxHash?: string;
  notes?: string[];
}

export interface Event {
  id: number;
  at: number;
  decisionId: string | null;
  kind: string;
  data: string;
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        decision_id TEXT PRIMARY KEY,
        stage       TEXT NOT NULL,
        data        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          INTEGER NOT NULL,
        decision_id TEXT,
        kind        TEXT NOT NULL,
        data        TEXT NOT NULL
      );
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

  getRun(decisionId: bigint): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE decision_id = ?").get(decisionId.toString()) as
      | { decision_id: string; stage: Stage; data: string; updated_at: number }
      | undefined;
    if (!row) return undefined;
    return { decisionId: BigInt(row.decision_id), stage: row.stage, data: JSON.parse(row.data) as RunData, updatedAt: row.updated_at };
  }

  /** Creates the run if missing (idempotent). */
  startRun(decisionId: bigint, stage: Stage, data: RunData, now = Date.now()): Run {
    const existing = this.getRun(decisionId);
    if (existing) return existing;
    this.db.prepare("INSERT INTO runs (decision_id, stage, data, updated_at) VALUES (?, ?, ?, ?)").run(decisionId.toString(), stage, json(data), now);
    this.event("run.start", { stage, ...data }, decisionId, now);
    return { decisionId, stage, data, updatedAt: now };
  }

  /** Moves a run to `stage`, merging `patch` into its data, in one transaction with an event. */
  transition(decisionId: bigint, stage: Stage, patch: Partial<RunData> = {}, now = Date.now()): Run {
    const run = this.getRun(decisionId);
    if (!run) throw new Error(`no run for decision ${decisionId}`);
    const data = { ...run.data, ...patch };
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE runs SET stage = ?, data = ?, updated_at = ? WHERE decision_id = ?").run(stage, json(data), now, decisionId.toString());
      this.event("run.transition", { from: run.stage, to: stage, ...patch }, decisionId, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { decisionId, stage, data, updatedAt: now };
  }

  /** Updates run data without changing the stage. */
  patch(decisionId: bigint, patch: Partial<RunData>, now = Date.now()): Run {
    const run = this.getRun(decisionId);
    if (!run) throw new Error(`no run for decision ${decisionId}`);
    const data = { ...run.data, ...patch };
    this.db.prepare("UPDATE runs SET data = ?, updated_at = ? WHERE decision_id = ?").run(json(data), now, decisionId.toString());
    return { ...run, data, updatedAt: now };
  }

  event(kind: string, data: unknown, decisionId?: bigint, at = Date.now()): void {
    this.db.prepare("INSERT INTO events (at, decision_id, kind, data) VALUES (?, ?, ?, ?)").run(at, decisionId?.toString() ?? null, kind, json(data));
  }

  events(limit = 100, decisionId?: bigint): Event[] {
    const rows = decisionId === undefined
      ? this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM events WHERE decision_id = ? ORDER BY id DESC LIMIT ?").all(decisionId.toString(), limit);
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      at: r.at as number,
      decisionId: r.decision_id as string | null,
      kind: r.kind as string,
      data: r.data as string,
    }));
  }

  runs(): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY CAST(decision_id AS INTEGER)").all() as { decision_id: string; stage: Stage; data: string; updated_at: number }[];
    return rows.map((row) => ({ decisionId: BigInt(row.decision_id), stage: row.stage, data: JSON.parse(row.data) as RunData, updatedAt: row.updated_at }));
  }

  close(): void {
    this.db.close();
  }
}
