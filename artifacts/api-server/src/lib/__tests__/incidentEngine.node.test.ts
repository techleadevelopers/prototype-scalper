import assert from "node:assert/strict";
import test from "node:test";
import {
  _resetIncidentEngineForTesting,
  acknowledgeIncident,
  listIncidents,
  upsertIncident,
} from "../incidentEngine";

const baseIncident = {
  severity: "CRITICAL" as const,
  fingerprint: "kill-switch:hard-pause",
  title: "Kill switch is in HARD_PAUSE",
  metric: "killSwitch.state",
  suggestedAction: "Investigate before reset.",
  subsystem: "killSwitch",
};

test("incident dedupe honors cooldown and keeps one active fingerprint", () => {
  _resetIncidentEngineForTesting();
  const now = Date.now();
  upsertIncident(baseIncident, now);
  upsertIncident(baseIncident, now + 500);
  assert.equal(listIncidents().length, 1);
  assert.equal(listIncidents()[0]?.occurrences, 1);

  upsertIncident(baseIncident, now + 61_000);
  assert.equal(listIncidents().length, 1);
  assert.equal(listIncidents()[0]?.occurrences, 2);
});

test("acknowledge marks but does not remove an active incident", () => {
  _resetIncidentEngineForTesting();
  const now = Date.now();
  upsertIncident(baseIncident, now);
  const acknowledged = acknowledgeIncident(baseIncident.fingerprint, now + 1_000);
  assert.equal(acknowledged?.acknowledgedAt, now + 1_000);

  const incidents = listIncidents();
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.status, "ACTIVE");
  assert.equal(incidents[0]?.acknowledgedAt, now + 1_000);
});
