export type PositionSide = "LONG" | "SHORT";

export interface ExecutionPnlInput {
  positionSide: PositionSide;
  openedQuantity: number;
  closedQuantity: number;
  entryPrice: number;
  exitPrice: number;
  exchangeCommission: number;
  funding?: number;
}

export interface ExecutionPnl {
  openedQuantity: number;
  closedQuantity: number;
  remainingQuantity: number;
  grossRealizedPnl: number;
  exchangeCommission: number;
  funding: number;
  netRealizedPnl: number;
}

export interface CampaignAccounting {
  campaignId: string;
  executionPnl: number[];
  finalOutcomeCount: number;
  campaignPnl: number;
}

export interface FinancialAccountingInput {
  initialEquity: number;
  currentEquity: number;
  reservedMargin: number;
  releasedMargin: number;
  grossRealizedPnl: number;
  exchangeCommission: number;
  unrealizedPnl: number;
  campaignPnl: number[];
  executionPnl: number[];
}

export interface FinancialAccounting extends FinancialAccountingInput {
  netRealizedPnl: number;
  totalCampaignPnl: number;
  totalExecutionPnl: number;
  equityReconciliationDifference: number;
}

const EPSILON = 1e-9;

function requireFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
}

export function computeExecutionPnl(input: ExecutionPnlInput): ExecutionPnl {
  requireFiniteNonNegative("openedQuantity", input.openedQuantity);
  requireFiniteNonNegative("closedQuantity", input.closedQuantity);
  requireFiniteNonNegative("exchangeCommission", input.exchangeCommission);
  requireFiniteNonNegative("entryPrice", input.entryPrice);
  requireFiniteNonNegative("exitPrice", input.exitPrice);

  if (input.closedQuantity - input.openedQuantity > EPSILON) {
    throw new Error("closedQuantity cannot exceed openedQuantity");
  }

  const direction = input.positionSide === "LONG" ? 1 : -1;
  const grossRealizedPnl =
    direction * (input.exitPrice - input.entryPrice) * input.closedQuantity;
  const funding = input.funding ?? 0;
  if (!Number.isFinite(funding)) throw new Error("funding must be finite");

  return {
    openedQuantity: input.openedQuantity,
    closedQuantity: input.closedQuantity,
    remainingQuantity: input.openedQuantity - input.closedQuantity,
    grossRealizedPnl,
    exchangeCommission: input.exchangeCommission,
    funding,
    netRealizedPnl: grossRealizedPnl - input.exchangeCommission + funding,
  };
}

export function allocateClosedQuantity<T extends {
  tradeId: string;
  entryTime: number;
  remainingQuantity: number;
}>(
  entries: T[],
  quantityToClose: number,
): Array<{ entry: T; closedQuantity: number; remainingQuantity: number }> {
  requireFiniteNonNegative("quantityToClose", quantityToClose);
  const available = entries.reduce((sum, entry) => sum + entry.remainingQuantity, 0);
  if (quantityToClose - available > EPSILON) {
    throw new Error("close quantity exceeds tracked exposure");
  }

  let unallocated = quantityToClose;
  const result: Array<{ entry: T; closedQuantity: number; remainingQuantity: number }> = [];
  for (const entry of [...entries].sort((a, b) => a.entryTime - b.entryTime)) {
    const closedQuantity = Math.min(entry.remainingQuantity, unallocated);
    result.push({
      entry,
      closedQuantity,
      remainingQuantity: entry.remainingQuantity - closedQuantity,
    });
    unallocated -= closedQuantity;
  }
  return result;
}

export function assertCampaignAccounting(accounting: CampaignAccounting): void {
  if (accounting.finalOutcomeCount !== 1) {
    throw new Error(`campaign ${accounting.campaignId} must have exactly one final outcome`);
  }
  const executionTotal = accounting.executionPnl.reduce((sum, pnl) => sum + pnl, 0);
  if (Math.abs(executionTotal - accounting.campaignPnl) > EPSILON) {
    throw new Error(`campaign ${accounting.campaignId} PnL does not equal execution PnL`);
  }
}

export function assertExposureInvariant(
  positionSide: PositionSide,
  side: "BUY" | "SELL",
  openedQuantity: number,
  closedQuantity: number,
): void {
  const expectedSide = positionSide === "LONG" ? "BUY" : "SELL";
  if (side !== expectedSide) {
    throw new Error(`${positionSide} entry side must be ${expectedSide}`);
  }
  requireFiniteNonNegative("openedQuantity", openedQuantity);
  requireFiniteNonNegative("closedQuantity", closedQuantity);
  if (closedQuantity - openedQuantity > EPSILON) {
    throw new Error("closed exposure cannot exceed opened exposure");
  }
}

export function reconcileFinancialAccounting(
  input: FinancialAccountingInput,
): FinancialAccounting {
  requireFiniteNonNegative("initialEquity", input.initialEquity);
  requireFiniteNonNegative("currentEquity", input.currentEquity);
  requireFiniteNonNegative("reservedMargin", input.reservedMargin);
  requireFiniteNonNegative("releasedMargin", input.releasedMargin);
  requireFiniteNonNegative("exchangeCommission", input.exchangeCommission);

  const totalCampaignPnl = input.campaignPnl.reduce((sum, value) => sum + value, 0);
  const totalExecutionPnl = input.executionPnl.reduce((sum, value) => sum + value, 0);
  if (Math.abs(totalCampaignPnl - totalExecutionPnl) > EPSILON) {
    throw new Error("campaign PnL must equal execution PnL");
  }

  const netRealizedPnl = input.grossRealizedPnl - input.exchangeCommission;
  const expectedCurrentEquity =
    input.initialEquity + netRealizedPnl + input.unrealizedPnl;

  return {
    ...input,
    netRealizedPnl,
    totalCampaignPnl,
    totalExecutionPnl,
    equityReconciliationDifference: input.currentEquity - expectedCurrentEquity,
  };
}
