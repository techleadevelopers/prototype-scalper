import { createRequire } from "module";
import fs from "fs";
import path from "path";
import type { TradeOutcome } from "./adaptiveEngine";
import { TradeOutcomeSchema } from "./adaptiveEngine";
import { logger } from "./logger";

type BetterSqliteDatabase = {
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

type BetterSqliteCtor = new (filename: string) => BetterSqliteDatabase;

const require = createRequire(path.join(process.cwd(), "package.json"));
const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "trade-outcomes.sqlite");

let db: BetterSqliteDatabase | null = null;
let enabled = false;

function loadDriver(): BetterSqliteCtor | null {
  try {
    return require("better-sqlite3") as BetterSqliteCtor;
  } catch {
    return null;
  }
}

export function initSqliteOutcomeStore(): boolean {
  const mode = (process.env["OUTCOME_STORE"] ?? "jsonl").trim().toLowerCase();
  if (mode === "jsonl" || mode === "off") return false;

  const Driver = loadDriver();
  if (!Driver) {
    if (mode === "sqlite") {
      logger.warn("OUTCOME_STORE=sqlite requested but better-sqlite3 is not installed; falling back to JSONL");
    }
    return false;
  }

  const dbPath = process.env["OUTCOME_SQLITE_PATH"] ?? DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Driver(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_outcomes (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      position_side TEXT NOT NULL,
      source TEXT,
      source_type TEXT,
      entry_time INTEGER NOT NULL,
      exit_time INTEGER NOT NULL,
      realized_pnl REAL NOT NULL,
      market_event_id TEXT,
      client_order_id TEXT,
      exchange_order_id TEXT,
      payload TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_entry_time ON trade_outcomes(entry_time);
    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_market_event ON trade_outcomes(market_event_id);
    CREATE INDEX IF NOT EXISTS idx_trade_outcomes_client_order ON trade_outcomes(client_order_id);
  `);
  enabled = true;
  logger.info({ dbPath }, "SQLite outcome store enabled");
  return true;
}

export function sqliteOutcomeStoreEnabled(): boolean {
  return enabled && db !== null;
}

export function loadSqliteOutcomes(): TradeOutcome[] {
  if (!db) return [];
  const rows = db.prepare("SELECT payload FROM trade_outcomes ORDER BY entry_time ASC").all() as Array<{ payload?: unknown }>;
  const outcomes: TradeOutcome[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.payload ?? ""));
      const validation = TradeOutcomeSchema.safeParse(parsed);
      if (validation.success) outcomes.push(validation.data);
    } catch {
      // Skip corrupt rows; JSONL fallback remains available if enabled.
    }
  }
  return outcomes;
}

export function getSqliteOutcomeById(id: string): TradeOutcome | null {
  if (!db) return null;
  const row = db.prepare("SELECT payload FROM trade_outcomes WHERE id=?").get(id) as { payload?: unknown } | undefined;
  if (!row) return null;
  const validation = TradeOutcomeSchema.safeParse(JSON.parse(String(row.payload ?? "")));
  return validation.success ? validation.data : null;
}

export function upsertSqliteOutcome(outcome: TradeOutcome): void {
  if (!db) return;
  db.prepare(`
    INSERT INTO trade_outcomes (
      id, symbol, position_side, source, source_type, entry_time, exit_time,
      realized_pnl, market_event_id, client_order_id, exchange_order_id, payload, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      symbol=excluded.symbol,
      position_side=excluded.position_side,
      source=excluded.source,
      source_type=excluded.source_type,
      entry_time=excluded.entry_time,
      exit_time=excluded.exit_time,
      realized_pnl=excluded.realized_pnl,
      market_event_id=excluded.market_event_id,
      client_order_id=excluded.client_order_id,
      exchange_order_id=excluded.exchange_order_id,
      payload=excluded.payload
  `).run(
    outcome.id,
    outcome.symbol,
    outcome.positionSide,
    outcome.source ?? null,
    outcome.sourceType ?? null,
    outcome.entryTime,
    outcome.exitTime,
    outcome.realizedPnl,
    outcome.marketEventId ?? null,
    outcome.clientOrderId ?? null,
    outcome.exchangeOrderId ?? outcome.entryOrderId ?? null,
    JSON.stringify(outcome),
    Date.now(),
  );
}

export function rewriteSqliteOutcomes(outcomes: TradeOutcome[]): void {
  if (!db) return;
  const insert = db.prepare(`
    INSERT INTO trade_outcomes (
      id, symbol, position_side, source, source_type, entry_time, exit_time,
      realized_pnl, market_event_id, client_order_id, exchange_order_id, payload, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM trade_outcomes");
    const recordedAt = Date.now();
    for (const outcome of outcomes) {
      insert.run(
        outcome.id,
        outcome.symbol,
        outcome.positionSide,
        outcome.source ?? null,
        outcome.sourceType ?? null,
        outcome.entryTime,
        outcome.exitTime,
        outcome.realizedPnl,
        outcome.marketEventId ?? null,
        outcome.clientOrderId ?? null,
        outcome.exchangeOrderId ?? outcome.entryOrderId ?? null,
        JSON.stringify(outcome),
        recordedAt,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
