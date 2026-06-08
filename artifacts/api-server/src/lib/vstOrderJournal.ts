import crypto from "crypto";
import fs from "fs";
import path from "path";

export type VstOrderState =
  | "REQUESTED"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "PARTIALLY_CLOSED"
  | "CLOSED"
  | "REJECTED"
  | "CANCELED"
  | "UNKNOWN";

export interface VstOrderIntent {
  clientOrderId: string;
  exchangeOrderId: string | null;
  campaignId: string;
  symbol: string;
  side: "BUY" | "SELL";
  positionSide: "LONG" | "SHORT";
  requestedQuantity: number;
  filledQuantity: number;
  closedQuantity: number;
  state: VstOrderState;
  requestedAt: number;
  updatedAt: number;
  lastError: string | null;
}

let dataDir = path.join(process.cwd(), "data");
let orders = new Map<string, VstOrderIntent>();
let writeLock: Promise<void> = Promise.resolve();

function journalPath(): string {
  return path.join(dataDir, "vst-orders.json");
}

export function setVstOrderJournalDataDir(dir: string): void {
  dataDir = dir;
}

export function resetVstOrderJournalForTesting(): void {
  orders = new Map();
  writeLock = Promise.resolve();
}

async function persist(): Promise<void> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  const target = journalPath();
  const temp = `${target}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify([...orders.values()], null, 2), "utf8");
  await fs.promises.rename(temp, target);
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function initVstOrderJournal(): Promise<void> {
  await fs.promises.mkdir(dataDir, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.promises.readFile(journalPath(), "utf8")) as VstOrderIntent[];
    orders = new Map(parsed.map((order) => [order.clientOrderId, order]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createClientOrderId(scope: string, idempotencyKey?: string): string {
  const source = idempotencyKey ?? crypto.randomUUID();
  const digest = crypto.createHash("sha256").update(`${scope}:${source}`).digest("hex").slice(0, 24);
  return `vst-${digest}`;
}

export async function recordOrderRequested(
  input: Omit<VstOrderIntent, "exchangeOrderId" | "filledQuantity" | "closedQuantity" | "state" | "requestedAt" | "updatedAt" | "lastError">,
): Promise<VstOrderIntent> {
  return serialized(async () => {
    const existing = orders.get(input.clientOrderId);
    if (existing) return existing;
    const now = Date.now();
    const order: VstOrderIntent = {
      ...input,
      exchangeOrderId: null,
      filledQuantity: 0,
      closedQuantity: 0,
      state: "REQUESTED",
      requestedAt: now,
      updatedAt: now,
      lastError: null,
    };
    orders.set(order.clientOrderId, order);
    await persist();
    return order;
  });
}

export async function updateOrderState(
  clientOrderId: string,
  patch: Partial<Omit<VstOrderIntent, "clientOrderId" | "requestedAt">>,
): Promise<VstOrderIntent> {
  return serialized(async () => {
    const current = orders.get(clientOrderId);
    if (!current) throw new Error(`unknown clientOrderId ${clientOrderId}`);
    const next = { ...current, ...patch, updatedAt: Date.now() };
    if (next.filledQuantity > next.requestedQuantity || next.closedQuantity > next.filledQuantity) {
      throw new Error("order quantity invariant violated");
    }
    orders.set(clientOrderId, next);
    await persist();
    return next;
  });
}

export function getOrderByClientOrderId(clientOrderId: string): VstOrderIntent | null {
  return orders.get(clientOrderId) ?? null;
}

export function getUnresolvedOrders(): VstOrderIntent[] {
  return [...orders.values()].filter((order) =>
    order.state === "REQUESTED" || order.state === "UNKNOWN" || order.state === "ACCEPTED",
  );
}

export function normalizeBingXOrderState(rawState: unknown, filled: number, requested: number): VstOrderState {
  const state = String(rawState ?? "").toUpperCase();
  if (state === "FILLED" || filled >= requested) return "FILLED";
  if (state.includes("PARTIAL") || filled > 0) return "PARTIALLY_FILLED";
  if (state === "NEW" || state === "PENDING" || state === "ACCEPTED") return "ACCEPTED";
  if (state === "CANCELED" || state === "CANCELLED") return "CANCELED";
  if (state === "REJECTED" || state === "EXPIRED") return "REJECTED";
  return "UNKNOWN";
}
