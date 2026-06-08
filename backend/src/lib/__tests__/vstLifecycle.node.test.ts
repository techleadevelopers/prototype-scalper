import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allocateClosedQuantity,
  assertCampaignAccounting,
  assertExposureInvariant,
  computeExecutionPnl,
  reconcileFinancialAccounting,
} from "../vstAccounting.ts";
import {
  createClientOrderId,
  getOrderByClientOrderId,
  initVstOrderJournal,
  normalizeBingXOrderState,
  recordOrderRequested,
  resetVstOrderJournalForTesting,
  setVstOrderJournalDataDir,
  updateOrderState,
} from "../vstOrderJournal.ts";

test("LONG and SHORT PnL use direction and subtract commission", () => {
  const long = computeExecutionPnl({
    positionSide: "LONG",
    openedQuantity: 2,
    closedQuantity: 1,
    entryPrice: 100,
    exitPrice: 110,
    exchangeCommission: 1,
  });
  const short = computeExecutionPnl({
    positionSide: "SHORT",
    openedQuantity: 2,
    closedQuantity: 2,
    entryPrice: 100,
    exitPrice: 90,
    exchangeCommission: 2,
  });
  assert.equal(long.remainingQuantity, 1);
  assert.equal(long.grossRealizedPnl, 10);
  assert.equal(long.netRealizedPnl, 9);
  assert.equal(short.grossRealizedPnl, 20);
  assert.equal(short.netRealizedPnl, 18);
});

test("partial stacked closure is allocated FIFO without exceeding exposure", () => {
  const allocation = allocateClosedQuantity([
    { tradeId: "first", entryTime: 1, remainingQuantity: 2 },
    { tradeId: "second", entryTime: 2, remainingQuantity: 3 },
  ], 4);
  assert.deepEqual(
    allocation.map((item) => [item.entry.tradeId, item.closedQuantity, item.remainingQuantity]),
    [["first", 2, 0], ["second", 2, 1]],
  );
  assert.throws(() => allocateClosedQuantity(allocation.map((item) => ({
    tradeId: item.entry.tradeId,
    entryTime: item.entry.entryTime,
    remainingQuantity: item.remainingQuantity,
  })), 2), /exceeds tracked exposure/);
});

test("direction, quantity and exactly-one campaign outcome invariants fail closed", () => {
  assert.throws(() => assertExposureInvariant("LONG", "SELL", 1, 0), /must be BUY/);
  assert.throws(() => computeExecutionPnl({
    positionSide: "LONG",
    openedQuantity: 1,
    closedQuantity: 2,
    entryPrice: 1,
    exitPrice: 2,
    exchangeCommission: 0,
  }), /cannot exceed/);
  assert.doesNotThrow(() => assertCampaignAccounting({
    campaignId: "campaign-1",
    executionPnl: [3, -1],
    campaignPnl: 2,
    finalOutcomeCount: 1,
  }));
  assert.throws(() => assertCampaignAccounting({
    campaignId: "campaign-1",
    executionPnl: [3, -1],
    campaignPnl: 2,
    finalOutcomeCount: 2,
  }), /exactly one/);
});

test("canonical accounting reconciles equity, margin, commission and PnL", () => {
  const accounting = reconcileFinancialAccounting({
    initialEquity: 1000,
    currentEquity: 1012,
    reservedMargin: 100,
    releasedMargin: 40,
    grossRealizedPnl: 15,
    exchangeCommission: 2,
    unrealizedPnl: -1,
    campaignPnl: [8, 5],
    executionPnl: [10, -2, 5],
  });
  assert.equal(accounting.netRealizedPnl, 13);
  assert.equal(accounting.totalCampaignPnl, 13);
  assert.equal(accounting.totalExecutionPnl, 13);
  assert.equal(accounting.equityReconciliationDifference, 0);
  assert.throws(() => reconcileFinancialAccounting({
    ...accounting,
    campaignPnl: [99],
  }), /campaign PnL must equal execution PnL/);
});

test("duplicate placement intent and restart recovery keep one client order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vst-journal-"));
  try {
    setVstOrderJournalDataDir(dir);
    resetVstOrderJournalForTesting();
    await initVstOrderJournal();
    const clientOrderId = createClientOrderId("sniper:BTC-USDT:LONG", "same-market-event");
    const input = {
      clientOrderId,
      campaignId: "campaign",
      symbol: "BTC-USDT",
      side: "BUY" as const,
      positionSide: "LONG" as const,
      requestedQuantity: 1,
    };
    const first = await recordOrderRequested(input);
    const duplicate = await recordOrderRequested(input);
    assert.equal(first.requestedAt, duplicate.requestedAt);

    await updateOrderState(clientOrderId, {
      exchangeOrderId: "exchange-1",
      filledQuantity: 0.4,
      state: "PARTIALLY_FILLED",
    });
    resetVstOrderJournalForTesting();
    await initVstOrderJournal();
    assert.equal(getOrderByClientOrderId(clientOrderId)?.exchangeOrderId, "exchange-1");
    assert.equal(getOrderByClientOrderId(clientOrderId)?.filledQuantity, 0.4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed, duplicated and missing exchange states normalize conservatively", () => {
  assert.equal(normalizeBingXOrderState("NEW", 0, 1), "ACCEPTED");
  assert.equal(normalizeBingXOrderState("NEW", 0.5, 1), "PARTIALLY_FILLED");
  assert.equal(normalizeBingXOrderState("FILLED", 1, 1), "FILLED");
  assert.equal(normalizeBingXOrderState(undefined, 0, 1), "UNKNOWN");
});
