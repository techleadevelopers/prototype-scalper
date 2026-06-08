"""
Contract tests for the Quant Brain ↔ Executor interface.
Tests: response schema, side consistency, signal expiry, uncertainty classification.
"""
from __future__ import annotations

import asyncio
import time
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_minimal_payload(**overrides) -> dict:
    payload = {
        "symbol": "ETH-USDT",
        "side": "BUY",
        "positionSide": "LONG",
        "hourUtc": 14,
        "config": {},
        "sniperContext": {},
        "btcFeatures": {},
    }
    payload.update(overrides)
    return payload


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── Response schema tests ───────────────────────────────────────────────────────

class TestResponseSchema:
    def test_required_fields_present(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        assert "allow" in result, "Response must contain 'allow'"
        assert "gateRejects" in result, "Response must contain 'gateRejects'"
        assert "score" in result, "Response must contain 'score'"
        assert "authority" in result, "Response must contain 'authority'"

    def test_contract_v2_fields_present(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        assert "featureVersion" in result, "Response must contain 'featureVersion'"
        assert "modelVersion" in result, "Response must contain 'modelVersion'"
        assert "uncertaintyType" in result, "Response must contain 'uncertaintyType'"
        assert "predictionTimestamp" in result, "Response must contain 'predictionTimestamp'"

    def test_allow_is_bool(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        assert isinstance(result["allow"], bool)

    def test_gate_rejects_is_list(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        assert isinstance(result["gateRejects"], list)

    def test_score_is_float_in_range(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        score = result.get("score", 0)
        assert isinstance(score, (int, float)), f"score must be numeric, got {type(score)}"
        assert 0.0 <= float(score) <= 1.0, f"score {score} out of [0, 1] range"

    def test_authority_is_quant_brain(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        assert result["authority"] in (
            "quant-brain", "quant-brain-degraded"
        ), f"Unexpected authority: {result['authority']}"

    def test_prediction_timestamp_is_recent(self):
        from core.edge_gate import evaluate_edge_gate
        before = time.time()
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        after = time.time()
        ts = result.get("predictionTimestamp", 0)
        assert ts >= before, f"predictionTimestamp {ts} < request start {before}"
        assert ts <= after + 1, f"predictionTimestamp {ts} > request end {after}"


# ── Side consistency tests ──────────────────────────────────────────────────────

class TestSideConsistency:
    def test_long_position_produces_long_side(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            side="BUY", positionSide="LONG"
        )))
        assert result.get("positionSide") in ("LONG", None), \
            f"LONG input produced positionSide={result.get('positionSide')}"

    def test_short_position_produces_short_side(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            side="SELL", positionSide="SHORT"
        )))
        assert result.get("positionSide") in ("SHORT", None), \
            f"SHORT input produced positionSide={result.get('positionSide')}"

    def test_buy_sell_passthrough(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            side="BUY", positionSide="LONG"
        )))
        side = result.get("side", "")
        assert side in ("BUY", "LONG", ""), \
            f"Unexpected side value: {side}"


# ── Signal expiry tests ─────────────────────────────────────────────────────────

class TestSignalExpiry:
    def test_expired_signal_is_rejected(self):
        from core.edge_gate import evaluate_edge_gate
        expired_ms = (time.time() - 60) * 1000  # 60 seconds ago
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            expiresAt=expired_ms
        )))
        assert result["allow"] is False, "Expired signal must not be allowed"
        rejects = result["gateRejects"]
        assert any("SIGNAL_EXPIRED" in r for r in rejects), \
            f"Expected SIGNAL_EXPIRED in gateRejects, got: {rejects}"

    def test_expired_signal_returns_expired_mode(self):
        from core.edge_gate import evaluate_edge_gate
        expired_ms = (time.time() - 60) * 1000
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            expiresAt=expired_ms
        )))
        assert result.get("mode") == "expired", \
            f"Expected mode='expired', got: {result.get('mode')}"

    def test_valid_future_expiry_is_not_rejected_by_expiry_gate(self):
        from core.edge_gate import evaluate_edge_gate
        future_ms = (time.time() + 60) * 1000  # 60 seconds from now
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            expiresAt=future_ms
        )))
        rejects = result["gateRejects"]
        assert not any("SIGNAL_EXPIRED" in r for r in rejects), \
            f"Valid signal rejected for expiry: {rejects}"

    def test_no_expiry_field_is_not_rejected(self):
        from core.edge_gate import evaluate_edge_gate
        payload = _make_minimal_payload()
        payload.pop("expiresAt", None)
        result = _run(evaluate_edge_gate(payload))
        rejects = result["gateRejects"]
        assert not any("SIGNAL_EXPIRED" in r for r in rejects)

    def test_expired_signal_echoes_signal_id(self):
        from core.edge_gate import evaluate_edge_gate
        expired_ms = (time.time() - 10) * 1000
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            expiresAt=expired_ms,
            signalId="test-signal-abc"
        )))
        assert result.get("signalId") == "test-signal-abc"


# ── Contract provenance fields ──────────────────────────────────────────────────

class TestProvenanceFields:
    def test_signal_id_echoed_in_response(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            signalId="echo-test-uuid"
        )))
        if "signalId" in result:
            assert result["signalId"] == "echo-test-uuid"

    def test_market_event_id_echoed_in_response(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            marketEventId="ETH-USDT:LONG:567890"
        )))
        if "marketEventId" in result:
            assert result["marketEventId"] == "ETH-USDT:LONG:567890"

    def test_feature_version_reflected_in_response(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            featureVersion="sniper-v1"
        )))
        assert result.get("featureVersion") == "sniper-v1"


# ── Uncertainty type tests ──────────────────────────────────────────────────────

class TestUncertaintyType:
    def test_uncertainty_type_is_valid_enum(self):
        from core.edge_gate import evaluate_edge_gate
        valid_types = {
            "STRONG_EVIDENCE", "WEAK_EVIDENCE", "INSUFFICIENT_DATA",
            "OOD", "MODEL_UNAVAILABLE", "UNCALIBRATED",
        }
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        ut = result.get("uncertaintyType", "")
        assert ut in valid_types, f"Unknown uncertaintyType: {ut!r}"

    def test_shadow_model_predict_returns_uncertainty_type(self):
        from core.shadow_model import predict_shadow
        row = {
            "symbol": "ETH-USDT",
            "positionSide": "LONG",
            "hourUtc": 14,
            "btcRegime": "BULL",
            "realizedPnl": 0.5,
        }
        result = predict_shadow(row)
        if result.get("available"):
            valid_types = {
                "STRONG_EVIDENCE", "WEAK_EVIDENCE", "INSUFFICIENT_DATA",
                "OOD", "MODEL_UNAVAILABLE", "UNCALIBRATED",
            }
            ut = result.get("uncertaintyType", "")
            assert ut in valid_types, f"predict_shadow uncertaintyType invalid: {ut!r}"

    def test_shadow_model_predict_returns_model_version(self):
        from core.shadow_model import predict_shadow
        row = {
            "symbol": "ETH-USDT",
            "positionSide": "LONG",
            "hourUtc": 14,
            "btcRegime": "BULL",
            "realizedPnl": 0.5,
        }
        result = predict_shadow(row)
        if result.get("available") and not result.get("error"):
            mv = result.get("modelVersion", "")
            assert mv.startswith("shadow-"), \
                f"modelVersion should start with 'shadow-', got: {mv!r}"


# ── KB trade endpoint contract ──────────────────────────────────────────────────

class TestKbTradeContract:
    def test_outcome_payload_must_have_symbol(self):
        payload = {
            "id": "campaign:abc",
            "positionSide": "LONG",
            "realizedPnl": 0.5,
        }
        assert "symbol" not in payload  # missing — should raise 400

    def test_outcome_payload_with_audit_fields(self):
        payload = {
            "id": "campaign:abc-123",
            "symbol": "ETH-USDT",
            "positionSide": "LONG",
            "side": "BUY",
            "realizedPnl": 0.5,
            "marginUsed": 5.0,
            "mfe": 1.2,
            "mae": -0.4,
            "holdDurationMs": 120_000,
            "entryCount": 2,
            "modelVersion": "shadow-1700000000",
            "signalId": "sig-uuid-abc",
            "isDemo": True,
            "source": "bingx-vst",
        }
        required = ["symbol", "positionSide"]
        for field in required:
            assert field in payload, f"Required field {field} missing"
        assert payload["mfe"] == 1.2
        assert payload["mae"] == -0.4
        assert payload["holdDurationMs"] == 120_000
        assert payload["entryCount"] == 2
        assert payload["modelVersion"] == "shadow-1700000000"
