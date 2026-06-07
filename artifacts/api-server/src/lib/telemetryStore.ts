/**
 * Telemetry Store — persistent trade outcome log with adaptive engine integration.
 *
 * Storage: append-only JSONL file (one JSON object per line).
 * Equivalent to the Postgres/SQLite storage in the MEV runtime, but lighter.
 *
 * On startup: loads all records from disk → rebuilds EWMA state in AdaptiveEngine.
 * On each new trade: appends to JSONL file + updates engine in-memory.
 *
 * This design matches the MEV "rollup-first storage model" — high-frequency telemetry
 * is kept as minimal records, not raw order blobs. Profiles are recomputed in-memory.
 *
 * Nível Máximo de Excelência:
 * - Schema validation com Zod
 * - Backup automático com compressão
 * - Streaming de leitura para arquivos grandes
 * - Recuperação de corrupção de arquivo
 * - Métricas e health checks
 * - Rotação de arquivo por tamanho
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as zlib from "zlib";
import { promisify } from "util";
import { pipeline } from "stream";
import { createReadStream, createWriteStream } from "fs";
import readline from "readline";
import { AdaptiveEngine, type TradeOutcome, type BtcRegime, type PositionSide, type ExitReason, TradeOutcomeSchema } from "./adaptiveEngine";
import { logger, logMetric, logAlert } from "./logger";

const pipelineAsync = promisify(pipeline);

// ========== CONSTANTS ==========

const TELEMETRY_FILE = path.join(process.cwd(), "telemetry.jsonl");
const TELEMETRY_BACKUP_DIR = path.join(process.cwd(), "backups");
const TELEMETRY_MAX_SIZE_MB = parseInt(process.env.TELEMETRY_MAX_SIZE_MB || "100", 10);
const TELEMETRY_MAX_BACKUPS = parseInt(process.env.TELEMETRY_MAX_BACKUPS || "10", 10);
const TELEMETRY_FLUSH_INTERVAL_MS = parseInt(process.env.TELEMETRY_FLUSH_INTERVAL_MS || "5000", 10);
const TELEMETRY_COMPRESS_BACKUPS = process.env.TELEMETRY_COMPRESS_BACKUPS !== "false";

// ========== STATE ==========

let engine: AdaptiveEngine;
let fileStream: fs.WriteStream | null = null;
let writeBuffer: string[] = [];
let flushInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;
let lastHealthCheck = Date.now();
let totalRecords = 0;
let lastBackupSize = 0;

// ========== UTILITY FUNCTIONS ==========

function ensureDirectories(): void {
  if (!fs.existsSync(TELEMETRY_BACKUP_DIR)) {
    fs.mkdirSync(TELEMETRY_BACKUP_DIR, { recursive: true });
  }
}

function getFileSizeMB(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size / (1024 * 1024);
  } catch {
    return 0;
  }
}

function getRotatedFileName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(TELEMETRY_BACKUP_DIR, `telemetry-${timestamp}.jsonl`);
}

async function compressFile(inputPath: string, outputPath: string): Promise<void> {
  const readStream = createReadStream(inputPath);
  const writeStream = createWriteStream(outputPath);
  const gzip = zlib.createGzip();

  await pipelineAsync(readStream, gzip, writeStream);
}

async function rotateTelemetryFile(): Promise<void> {
  if (!fs.existsSync(TELEMETRY_FILE)) return;

  const sizeMB = getFileSizeMB(TELEMETRY_FILE);
  if (sizeMB < TELEMETRY_MAX_SIZE_MB) return;

  logger.info({ sizeMB, maxMB: TELEMETRY_MAX_SIZE_MB }, "Rotating telemetry file");

  // Flush any pending writes
  await flushWriteBuffer();

  // Close current stream
  if (fileStream) {
    fileStream.end();
    fileStream = null;
  }

  // Rotate file
  const rotatedPath = getRotatedFileName();
  fs.renameSync(TELEMETRY_FILE, rotatedPath);

  // Compress if configured
  if (TELEMETRY_COMPRESS_BACKUPS) {
    const compressedPath = `${rotatedPath}.gz`;
    await compressFile(rotatedPath, compressedPath);
    fs.unlinkSync(rotatedPath);
    logger.info({ compressedPath }, "Compressed rotated telemetry file");
  }

  // Clean up old backups
  await cleanupOldBackups();

  // Create new stream
  fileStream = fs.createWriteStream(TELEMETRY_FILE, { flags: "a", encoding: "utf-8" });
  logger.info("Created new telemetry file after rotation");
}

async function cleanupOldBackups(): Promise<void> {
  try {
    const files = fs.readdirSync(TELEMETRY_BACKUP_DIR);
    const backupFiles = files
      .filter(f => f.startsWith("telemetry-") && (f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")))
      .map(f => ({
        name: f,
        path: path.join(TELEMETRY_BACKUP_DIR, f),
        mtime: fs.statSync(path.join(TELEMETRY_BACKUP_DIR, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    // Delete old backups beyond limit
    const toDelete = backupFiles.slice(TELEMETRY_MAX_BACKUPS);
    for (const file of toDelete) {
      fs.unlinkSync(file.path);
      logger.info({ file: file.name }, "Deleted old backup");
    }
  } catch (err) {
    logger.error({ err }, "Failed to cleanup old backups");
  }
}

function recoverFromCorruption(): TradeOutcome[] {
  logger.warn("Attempting to recover telemetry file from corruption");

  const validOutcomes: TradeOutcome[] = [];
  let corruptedLines = 0;

  try {
    const content = fs.readFileSync(TELEMETRY_FILE, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        const validation = TradeOutcomeSchema.safeParse(parsed);
        if (validation.success) {
          validOutcomes.push(validation.data);
        } else {
          corruptedLines++;
        }
      } catch {
        corruptedLines++;
      }
    }

    if (corruptedLines > 0) {
      // Save recovery backup
      const recoveryPath = path.join(TELEMETRY_BACKUP_DIR, `recovery-${Date.now()}.jsonl`);
      fs.writeFileSync(recoveryPath, content);
      logger.warn({ corruptedLines, recoveredCount: validOutcomes.length, recoveryPath }, "Recovered with corruption");

      // Rewrite clean file
      const cleanContent = validOutcomes.map(o => JSON.stringify(o)).join("\n");
      fs.writeFileSync(TELEMETRY_FILE, cleanContent);

      logAlert({
        severity: "high",
        source: "telemetry",
        message: `Telemetry file corrupted, recovered ${validOutcomes.length} records, ${corruptedLines} lost`,
        metadata: { corruptedLines, recoveredCount: validOutcomes.length },
      });
    }
  } catch (err) {
    logger.error({ err }, "Failed to recover telemetry file");
  }

  return validOutcomes;
}

async function getLatestBackup(): Promise<string | null> {
  try {
    const files = fs.readdirSync(TELEMETRY_BACKUP_DIR);
    const backupFiles = files
      .filter(f => f.startsWith("telemetry-") && (f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")))
      .map(f => path.join(TELEMETRY_BACKUP_DIR, f))
      .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());

    if (backupFiles.length === 0) return null;

    const latest = backupFiles[0];
    if (latest.endsWith(".gz")) {
      // Need to decompress
      const decompressedPath = latest.replace(".gz", "");
      const readStream = createReadStream(latest);
      const writeStream = createWriteStream(decompressedPath);
      const gunzip = zlib.createGunzip();
      await pipelineAsync(readStream, gunzip, writeStream);
      return decompressedPath;
    }

    return latest;
  } catch {
    return null;
  }
}

// ========== SLIPPAGE UTILITIES ==========

function computeSlippage(
  positionSide: PositionSide,
  expectedPrice: number | undefined,
  executedPrice: number,
  qty: number,
  leg: "entry" | "exit",
): number {
  if (!expectedPrice || expectedPrice <= 0 || executedPrice <= 0 || qty <= 0) return 0;
  const isLong = positionSide === "LONG";
  const adversePriceMove = leg === "entry"
    ? (isLong ? executedPrice - expectedPrice : expectedPrice - executedPrice)
    : (isLong ? expectedPrice - executedPrice : executedPrice - expectedPrice);
  return Math.max(0, adversePriceMove * qty);
}

// ========== DISK I/O ==========

function loadFromDisk(): TradeOutcome[] {
  if (!fs.existsSync(TELEMETRY_FILE)) return [];

  try {
    const stats = fs.statSync(TELEMETRY_FILE);
    const sizeMB = stats.size / (1024 * 1024);

    logger.info({ sizeMB, file: TELEMETRY_FILE }, "Loading telemetry file");

    const content = fs.readFileSync(TELEMETRY_FILE, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    const outcomes: TradeOutcome[] = [];
    let parseErrors = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const validation = TradeOutcomeSchema.safeParse(parsed);
        if (validation.success) {
          outcomes.push(validation.data);
        } else {
          parseErrors++;
        }
      } catch {
        parseErrors++;
      }
    }

    if (parseErrors > 0) {
      logger.warn({ parseErrors, totalLines: lines.length }, "Parse errors during telemetry load");

      if (parseErrors > lines.length * 0.1) {
        // More than 10% corruption, attempt recovery
        return recoverFromCorruption();
      }
    }

    return outcomes;
  } catch (err) {
    logger.error({ err }, "Failed to load telemetry file, attempting recovery");
    return recoverFromCorruption();
  }
}

function loadFromDiskStreaming(): Promise<TradeOutcome[]> {
  const outcomes: TradeOutcome[] = [];
  let parseErrors = 0;

  const rl = readline.createInterface({
    input: createReadStream(TELEMETRY_FILE),
    crlfDelay: Infinity,
  });

  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        const validation = TradeOutcomeSchema.safeParse(parsed);
        if (validation.success) {
          outcomes.push(validation.data);
        } else {
          parseErrors++;
        }
      } catch {
        parseErrors++;
      }
    });

    rl.on("close", () => {
      if (parseErrors > 0) {
        logger.warn({ parseErrors, totalOutcomes: outcomes.length }, "Parse errors during streaming load");
      }
      resolve(outcomes);
    });
  });
}

async function flushWriteBuffer(): Promise<void> {
  if (writeBuffer.length === 0) return;

  const toWrite = writeBuffer.join("\n");
  writeBuffer = [];

  if (!fileStream || fileStream.destroyed) {
    fileStream = fs.createWriteStream(TELEMETRY_FILE, { flags: "a", encoding: "utf-8" });
  }

  return new Promise((resolve, reject) => {
    fileStream!.write(toWrite + "\n", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function appendToDiskAsync(outcome: TradeOutcome): void {
  writeBuffer.push(JSON.stringify(outcome));
  totalRecords++;

  // Force flush if buffer is getting large
  if (writeBuffer.length >= 100) {
    flushWriteBuffer().catch(err => {
      logger.error({ err }, "Failed to flush telemetry buffer");
    });
  }
}

function rewriteTelemetryFile(outcomes: TradeOutcome[]): void {
  const content = outcomes.map((outcome) => JSON.stringify(outcome)).join("\n");
  fs.writeFileSync(TELEMETRY_FILE, content ? `${content}\n` : "", "utf-8");
  totalRecords = outcomes.length;
}

// ========== HEALTH MONITORING ==========

async function performHealthCheck(): Promise<boolean> {
  const now = Date.now();
  if (now - lastHealthCheck < 60000) return true; // Once per minute

  lastHealthCheck = now;

  const fileSizeMB = getFileSizeMB(TELEMETRY_FILE);
  const isHealthy = fileSizeMB < TELEMETRY_MAX_SIZE_MB * 1.5;

  if (!isHealthy) {
    logAlert({
      severity: "medium",
      source: "telemetry",
      message: `Telemetry file size ${fileSizeMB.toFixed(1)}MB exceeds limit`,
      metadata: { fileSizeMB, limitMB: TELEMETRY_MAX_SIZE_MB },
    });
  }

  logMetric({
    name: "telemetry.file_size_mb",
    value: fileSizeMB,
    unit: "mb",
  });

  logMetric({
    name: "telemetry.total_records",
    value: totalRecords,
  });

  return isHealthy;
}

// ========== PUBLIC API ==========

/** Initialize the store — call once at server startup */
export function initTelemetryStore(): AdaptiveEngine {
  ensureDirectories();

  logger.info({ telemetryFile: TELEMETRY_FILE, maxSizeMB: TELEMETRY_MAX_SIZE_MB }, "Initializing telemetry store");

  const historical = loadFromDisk();
  totalRecords = historical.length;

  logger.info({ historicalTrades: totalRecords }, "Loaded historical trades");

  engine = new AdaptiveEngine(historical);

  // Open file stream for appending
  fileStream = fs.createWriteStream(TELEMETRY_FILE, { flags: "a", encoding: "utf-8" });

  // Start flush interval
  flushInterval = setInterval(() => {
    if (!isShuttingDown) {
      flushWriteBuffer().catch(err => {
        logger.error({ err }, "Failed to flush telemetry buffer");
      });
    }
  }, TELEMETRY_FLUSH_INTERVAL_MS);

  // Start health check loop
  setInterval(() => {
    performHealthCheck().catch(err => {
      logger.error({ err }, "Health check failed");
    });
  }, 60000);

  // Check rotation on startup
  rotateTelemetryFile().catch(err => {
    logger.error({ err }, "Failed to check telemetry rotation");
  });

  return engine;
}

/** Get the live adaptive engine — always available after init */
export function getEngine(): AdaptiveEngine {
  if (!engine) {
    engine = new AdaptiveEngine([]);
  }
  return engine;
}

/** Get telemetry statistics */
export function getTelemetryStats(): {
  totalRecords: number;
  fileSizeMB: number;
  bufferSize: number;
  lastFlushTime: number;
  backupCount: number;
} {
  return {
    totalRecords,
    fileSizeMB: getFileSizeMB(TELEMETRY_FILE),
    bufferSize: writeBuffer.length,
    lastFlushTime: Date.now(),
    backupCount: fs.existsSync(TELEMETRY_BACKUP_DIR)
      ? fs.readdirSync(TELEMETRY_BACKUP_DIR).filter(f => f.startsWith("telemetry-")).length
      : 0,
  };
}

/**
 * Record a realized trade outcome.
 * Persists to disk AND updates in-memory EWMA state immediately.
 * Equivalent to the storage.record_outcome() + adaptive.apply_outcome() pipeline.
 */
export function recordTradeOutcome(raw: Omit<TradeOutcome, "id"> & { id?: string }): TradeOutcome {
  const outcome: TradeOutcome = {
    id: raw.id ?? crypto.randomUUID(),
    ...raw,
    hourUtc: raw.hourUtc ?? new Date(raw.entryTime).getUTCHours(),
  };

  // Validate before recording
  const validation = TradeOutcomeSchema.safeParse(outcome);
  if (!validation.success) {
    logger.error({ errors: validation.error.issues, outcome }, "Invalid trade outcome");
    throw new Error(`Invalid trade outcome: ${validation.error.issues.map((issue) => issue.message).join(", ")}`);
  }

  appendToDiskAsync(outcome);
  getEngine().recordOutcome(outcome);
  emitSseTrade(outcome);

  logMetric({
    name: "trade.recorded",
    value: 1,
    tags: { symbol: outcome.symbol, side: outcome.positionSide, result: outcome.realizedPnl > 0 ? "win" : "loss" },
  });

  // Check rotation periodically
  if (totalRecords % 100 === 0) {
    rotateTelemetryFile().catch(err => {
      logger.error({ err }, "Failed to rotate telemetry file");
    });
  }

  return outcome;
}

export async function updateTradeOutcome(
  id: string,
  patch: Partial<Omit<TradeOutcome, "id">>,
): Promise<TradeOutcome | null> {
  await flushWriteBuffer();

  const outcomes = loadFromDisk();
  const index = outcomes.findIndex((outcome) => outcome.id === id);
  if (index < 0) return null;

  const updated: TradeOutcome = {
    ...outcomes[index],
    ...patch,
    id,
  };

  const validation = TradeOutcomeSchema.safeParse(updated);
  if (!validation.success) {
    logger.error({ errors: validation.error.issues, id, patch }, "Invalid trade outcome update");
    throw new Error(`Invalid trade outcome update: ${validation.error.issues.map((issue) => issue.message).join(", ")}`);
  }

  outcomes[index] = validation.data;
  rewriteTelemetryFile(outcomes);
  getEngine().replaceOutcome(validation.data);

  logMetric({
    name: "trade.updated",
    value: 1,
    tags: { symbol: validation.data.symbol, side: validation.data.positionSide, pnlSource: validation.data.pnlSource ?? "unknown" },
  });

  return validation.data;
}

/**
 * Record multiple trade outcomes in batch
 */
export function recordTradeOutcomesBatch(outcomes: Array<Omit<TradeOutcome, "id"> & { id?: string }>): TradeOutcome[] {
  const recorded: TradeOutcome[] = [];
  for (const outcome of outcomes) {
    try {
      recorded.push(recordTradeOutcome(outcome));
    } catch (err) {
      logger.error({ err, outcome }, "Failed to record trade outcome in batch");
    }
  }
  return recorded;
}

/**
 * Reconstruct a TradeOutcome from a BingX order pair (entry + exit orders).
 * Converts raw BingX order data to the telemetry schema.
 */
export function buildOutcomeFromOrders(
  entryOrder: {
    orderId: string;
    symbol: string;
    side: string;
    positionSide: string;
    avgPrice: string;
    origQty: string;
    commission?: string | null;
    time: number;
  },
  exitOrder: {
    avgPrice: string;
    commission?: string | null;
    profit?: string | null;
    time: number;
  },
  context: {
    btcRegime: BtcRegime;
    leverage: number;
    marginUsed: number;
    expectedTpProfit: number;
    exitReason: ExitReason;
    expectedEntryPrice?: number;
    expectedExitPrice?: number;
  },
): TradeOutcome {
  const grossPnl = parseFloat(exitOrder.profit ?? "0");
  const entryFee = Math.abs(parseFloat(entryOrder.commission ?? "0"));
  const exitFee = Math.abs(parseFloat(exitOrder.commission ?? "0"));
  const fee = entryFee + exitFee;
  const realizedPnl = grossPnl - fee;
  const entryPrice = parseFloat(entryOrder.avgPrice);
  const exitPrice = parseFloat(exitOrder.avgPrice);
  const qty = parseFloat(entryOrder.origQty);
  const positionSide = entryOrder.positionSide as PositionSide;
  const expectedEntryPrice = context.expectedEntryPrice;
  const expectedExitPrice = context.expectedExitPrice;
  const entrySlippage = computeSlippage(positionSide, expectedEntryPrice, entryPrice, qty, "entry");
  const exitSlippage = computeSlippage(positionSide, expectedExitPrice, exitPrice, qty, "exit");
  const totalSlippage = entrySlippage + exitSlippage;
  const notional = entryPrice * qty;

  return {
    id: entryOrder.orderId,
    source: "bingx-live",
    symbol: entryOrder.symbol,
    positionSide,
    side: entryOrder.side as "BUY" | "SELL",
    entryTime: entryOrder.time,
    exitTime: exitOrder.time,
    hourUtc: new Date(entryOrder.time).getUTCHours(),
    btcRegime: context.btcRegime,
    entryPrice,
    exitPrice,
    qty,
    leverage: context.leverage,
    marginUsed: context.marginUsed,
    grossPnl,
    fee,
    realizedPnl,
    expectedEntryPrice,
    expectedExitPrice,
    entrySlippage,
    exitSlippage,
    totalSlippage,
    slippagePctNotional: notional > 0 ? totalSlippage / notional : 0,
    exitReason: context.exitReason,
    expectedTpProfit: context.expectedTpProfit,
  };
}

/** Export all raw outcomes (for backup or external analysis) */
export function exportAllOutcomes(): TradeOutcome[] {
  return getEngine().rawOutcomes();
}

/** Export outcomes as JSONL string */
export function exportOutcomesAsJsonl(): string {
  const outcomes = exportAllOutcomes();
  return outcomes.map(o => JSON.stringify(o)).join("\n");
}

/** How many trades are in the telemetry store */
export function tradeCount(): number {
  return getEngine().globalState().totalTrades;
}

// ── SSE emitter for real-time streaming ─────────────────────────────────────
const _sseEmitter = new EventEmitter();
_sseEmitter.setMaxListeners(100);

export function getTelemetrySseEmitter(): { sseEmitter: EventEmitter } {
  return { sseEmitter: _sseEmitter };
}

export function emitSseTrade(outcome: TradeOutcome): void {
  _sseEmitter.emit("trade", outcome);
}

/** Create a manual backup */
export async function createManualBackup(): Promise<string> {
  await flushWriteBuffer();
  const backupPath = getRotatedFileName();

  if (TELEMETRY_COMPRESS_BACKUPS) {
    await compressFile(TELEMETRY_FILE, `${backupPath}.gz`);
    logger.info({ backupPath: `${backupPath}.gz` }, "Created compressed manual backup");
    return `${backupPath}.gz`;
  } else {
    fs.copyFileSync(TELEMETRY_FILE, backupPath);
    logger.info({ backupPath }, "Created manual backup");
    return backupPath;
  }
}

/** Graceful shutdown — flush pending writes */
export async function shutdownTelemetryStore(): Promise<void> {
  isShuttingDown = true;

  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }

  await flushWriteBuffer();

  if (fileStream) {
    fileStream.end();
    fileStream = null;
  }

  logger.info("Telemetry store shut down");
}
