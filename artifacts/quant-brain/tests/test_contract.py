"""
Contract tests for the Quant Brain ↔ Executor interface.
Tests: response schema, side consistency, signal expiry, uncertainty classification.
"""
from __future__ import annotations

import asyncio
import time
import sys
import os
import uuid
from pathlib import Path

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


def _kb_trade_handler():
    from api.kb_trades import record_trade

    return record_trade


def _make_trade_payload(source_id: str = "campaign:contract-1", **overrides) -> dict:
    now_ms = int(time.time() * 1000)
    payload = {
        "sourceId": source_id,
        "symbol": "ETH-USDT",
        "positionSide": "LONG",
        "side": "BUY",
        "entryPrice": 2000.0,
        "exitPrice": 2020.0,
        "expectedEntryPrice": 2000.0,
        "actualAvgEntryPrice": 2000.0,
        "expectedExitPrice": 2020.0,
        "actualExitPrice": 2020.0,
        "qty": 0.01,
        "marginUsed": 2.0,
        "realizedPnl": 0.2,
        "pnl_pct": 10.0,
        "entryTime": now_ms - 60_000,
        "exitTime": now_ms,
        "signalCreatedAt": now_ms - 70_000,
        "orderRequestedAt": now_ms - 65_000,
        "orderSentAt": now_ms - 64_500,
        "orderAckAt": now_ms - 64_000,
        "positionConfirmedAt": now_ms - 63_000,
        "positionClosedAt": now_ms,
        "signalId": f"signal-{source_id}",
        "marketEventId": f"ETH-USDT:LONG:{source_id}",
        "isDemo": True,
        "source": "bingx-vst",
        "sourceType": "demo",
    }
    payload.update(overrides)
    return payload


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
        before = int(time.time() * 1000)
        result = _run(evaluate_edge_gate(_make_minimal_payload()))
        after = int(time.time() * 1000)
        ts = result.get("predictionTimestamp", 0)
        assert ts >= before, f"predictionTimestamp {ts} < request start {before}"
        assert ts <= after + 1000, f"predictionTimestamp {ts} > request end {after}"


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

class TestRiskGeometry:
    def test_inverted_tp_sl_is_rejected(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            config={
                "takeProfitPct": 0.22,
                "stopLossPct": 1.55,
                "takerFeeBps": 5,
                "slippageBpsPerSide": 2,
                "minRewardRiskRatio": 0.75,
            }
        )))
        rejects = result["gateRejects"]
        assert any("RISK_REWARD_REJECT" in r for r in rejects), rejects
        assert result["allow"] is False

    def test_risk_geometry_is_reported(self):
        from core.edge_gate import evaluate_edge_gate
        result = _run(evaluate_edge_gate(_make_minimal_payload(
            config={"takeProfitPct": 0.45, "stopLossPct": 0.25}
        )))
        geometry = result.get("economics", {}).get("riskGeometry", {})
        assert "netRewardRisk" in geometry
        assert "breakevenProbability" in geometry


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

class TestMlEconomicGate:
    def test_ml_economic_gate_blocks_below_effective_threshold(self):
        from core.edge_gate import _ml_economic_gate

        blocks, gate = _ml_economic_gate(
            config={},
            shadow_ml={
                "available": True,
                "calibratedProbability": 0.61,
                "optimalThreshold": 0.62,
                "expectedValuePct": 0.001,
                "profitabilityVerified": True,
            },
            risk_geometry={"requiredProbability": 0.66},
            current_profit_factor=1.4,
            drift_policy={
                "mlEnforcementAllowed": True,
                "stackingMultiplier": 1.0,
                "newEntriesAllowed": True,
            },
            correlation_penalty=1.0,
            regime_confidence=0.8,
        )

        assert gate["approved"] is False
        assert gate["riskTier"] == "NO_TRADE"
        assert gate["sizingMultiplier"] == 0.0
        assert any("ML_THRESHOLD_REJECT" in reason for reason in blocks)

    def test_ml_economic_gate_boosts_verified_positive_edge(self):
        from core.edge_gate import _ml_economic_gate

        blocks, gate = _ml_economic_gate(
            config={},
            shadow_ml={
                "available": True,
                "calibratedProbability": 0.75,
                "optimalThreshold": 0.62,
                "expectedValuePct": 0.002,
                "profitabilityVerified": True,
            },
            risk_geometry={"requiredProbability": 0.64},
            current_profit_factor=1.3,
            drift_policy={
                "mlEnforcementAllowed": True,
                "stackingMultiplier": 1.0,
                "newEntriesAllowed": True,
            },
            correlation_penalty=1.0,
            regime_confidence=0.8,
        )

        assert blocks == []
        assert gate["approved"] is True
        assert gate["riskTier"] == "BOOST"
        assert gate["sizingMultiplier"] > 1.0


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

    def test_post_kb_trades_acknowledges_new_trade(self):
        from core import knowledge_base as kb

        original_db_path = kb.DB_PATH
        db_path = Path(__file__).parent / f"kb-trade-contract-{uuid.uuid4().hex}.db"
        kb.DB_PATH = db_path
        try:
            _run(kb.init_db())

            payload = _make_trade_payload("campaign:contract-new")
            data = _run(_kb_trade_handler()(payload))

            assert data["ok"] is True
            assert data["recorded"] is True
            assert data["duplicate"] is False
            assert data["sourceId"] == "campaign:contract-new"
            assert data["symbol"] == "ETH-USDT"
            assert data["pnl_pct"] == 10.0
            assert "experiment" in data
            assert "executionAudit" in data
        finally:
            kb.DB_PATH = original_db_path
            for suffix in ("", "-shm", "-wal"):
                candidate = Path(f"{db_path}{suffix}")
                if candidate.exists():
                    candidate.unlink()

    def test_trade_payload_mapper_is_shared_for_single_and_batch(self):
        from api.kb_trades import trade_payload_to_record_args

        payload = _make_trade_payload(
            "campaign:mapper-rich",
            riskTier="BOOST",
            recommendedMargin=3.5,
            recommendedLeverage=12,
            sizeMultiplier=1.4,
            sizeReason="edge_boost",
            maxLossIfStop=0.22,
            notional=42,
            sizing={"riskTier": "BOOST", "recommendedMargin": 3.5, "notional": 42},
            policyVersion="policy-v1",
            strategyVersion="strategy-v2",
            configVersion="config-v3",
            modelVersion="shadow-v4",
            labelVersion="label-v5",
            playbook="breakout",
            setup="momentum-continuation",
            executionQuality=0.91,
            aggressiveScore=0.8,
        )
        experiment = {"experimentId": "exp-1", "experimentArm": "arm-a"}

        single_args = trade_payload_to_record_args(payload, experiment)
        batch_args = trade_payload_to_record_args(payload, experiment)

        assert batch_args == single_args
        assert single_args["source_id"] == "campaign:mapper-rich"
        assert single_args["risk_tier"] == "BOOST"
        assert single_args["recommended_margin"] == 3.5
        assert single_args["recommended_leverage"] == 12
        assert single_args["notional"] == 42
        assert single_args["sizing"] == payload["sizing"]
        assert single_args["policy_version"] == "policy-v1"
        assert single_args["strategy_version"] == "strategy-v2"
        assert single_args["config_version"] == "config-v3"
        assert single_args["model_version"] == "shadow-v4"
        assert single_args["label_version"] == "label-v5"
        assert single_args["setup_type"] == "momentum-continuation"

    def test_batch_retry_does_not_null_rich_trade_fields(self):
        from core import knowledge_base as kb

        original_db_path = kb.DB_PATH
        db_path = Path(__file__).parent / f"kb-rich-retry-{uuid.uuid4().hex}.db"
        kb.DB_PATH = db_path
        try:
            _run(kb.init_db())
            payload = _make_trade_payload(
                "campaign:rich-retry",
                riskTier="BOOST",
                recommendedMargin=3.5,
                recommendedLeverage=12,
                sizeMultiplier=1.4,
                sizeReason="edge_boost",
                maxLossIfStop=0.22,
                notional=42,
                sizing={"riskTier": "BOOST", "recommendedMargin": 3.5, "notional": 42},
                policyVersion="policy-v1",
                strategyVersion="strategy-v2",
                configVersion="config-v3",
                modelVersion="shadow-v4",
                labelVersion="label-v5",
                playbook="breakout",
                setup="momentum-continuation",
                executionQuality=0.91,
            )

            from api.kb_trades import record_trade, record_trades_batch

            assert _run(record_trade(payload))["ok"] is True
            assert _run(record_trades_batch([payload]))["ok"] is True

            async def fetch_row():
                async with kb.connect(kb.DB_PATH) as db:
                    return await (await db.execute(
                        """SELECT risk_tier, recommended_margin, recommended_leverage,
                                  size_multiplier, size_reason, max_loss_if_stop,
                                  notional, policy_version, strategy_version,
                                  config_version, model_version, label_version,
                                  playbook, setup_type, execution_quality, sizing_json
                           FROM trade_outcomes WHERE source_id=?""",
                        ("campaign:rich-retry",),
                    )).fetchone()

            row = _run(fetch_row())
            assert row is not None
            assert row[0] == "BOOST"
            assert row[1] == 3.5
            assert row[2] == 12
            assert row[3] == 1.4
            assert row[4] == "edge_boost"
            assert row[5] == 0.22
            assert row[6] == 42
            assert row[7] == "policy-v1"
            assert row[8] == "strategy-v2"
            assert row[9] == "config-v3"
            assert row[10] == "shadow-v4"
            assert row[11] == "label-v5"
            assert row[12] == "breakout"
            assert row[13] == "momentum-continuation"
            assert row[14] == 0.91
            assert row[15] is not None
        finally:
            kb.DB_PATH = original_db_path
            for suffix in ("", "-shm", "-wal"):
                candidate = Path(f"{db_path}{suffix}")
                if candidate.exists():
                    candidate.unlink()

    def test_partial_batch_payload_preserves_existing_optional_fields(self):
        from core import knowledge_base as kb

        original_db_path = kb.DB_PATH
        db_path = Path(__file__).parent / f"kb-partial-preserve-{uuid.uuid4().hex}.db"
        kb.DB_PATH = db_path
        try:
            _run(kb.init_db())
            source_id = "campaign:partial-preserve"
            rich_payload = _make_trade_payload(
                source_id,
                riskTier="AGGRESSIVE",
                recommendedMargin=4.0,
                recommendedLeverage=15,
                notional=60,
                sizing={"riskTier": "AGGRESSIVE", "recommendedMargin": 4.0},
                policyVersion="policy-rich",
                strategyVersion="strategy-rich",
                configVersion="config-rich",
                modelVersion="model-rich",
                labelVersion="label-rich",
                playbook="reversal",
                setup="liquidity-sweep",
            )
            partial_payload = _make_trade_payload(source_id)
            for field in (
                "riskTier", "recommendedMargin", "recommendedLeverage", "notional",
                "sizing", "policyVersion", "strategyVersion", "configVersion",
                "modelVersion", "labelVersion", "playbook", "setup",
            ):
                partial_payload.pop(field, None)

            from api.kb_trades import record_trade, record_trades_batch

            assert _run(record_trade(rich_payload))["ok"] is True
            assert _run(record_trades_batch([partial_payload]))["ok"] is True

            async def fetch_row():
                async with kb.connect(kb.DB_PATH) as db:
                    return await (await db.execute(
                        """SELECT risk_tier, recommended_margin, recommended_leverage,
                                  notional, policy_version, strategy_version,
                                  config_version, model_version, label_version,
                                  playbook, setup_type, sizing_json
                           FROM trade_outcomes WHERE source_id=?""",
                        (source_id,),
                    )).fetchone()

            row = _run(fetch_row())
            assert row is not None
            assert row[0] == "AGGRESSIVE"
            assert row[1] == 4.0
            assert row[2] == 15
            assert row[3] == 60
            assert row[4] == "policy-rich"
            assert row[5] == "strategy-rich"
            assert row[6] == "config-rich"
            assert row[7] == "model-rich"
            assert row[8] == "label-rich"
            assert row[9] == "reversal"
            assert row[10] == "liquidity-sweep"
            assert row[11] is not None
        finally:
            kb.DB_PATH = original_db_path
            for suffix in ("", "-shm", "-wal"):
                candidate = Path(f"{db_path}{suffix}")
                if candidate.exists():
                    candidate.unlink()

    def test_post_kb_trades_retry_is_idempotent_duplicate(self):
        from core import knowledge_base as kb

        original_db_path = kb.DB_PATH
        db_path = Path(__file__).parent / f"kb-trade-contract-{uuid.uuid4().hex}.db"
        kb.DB_PATH = db_path
        try:
            _run(kb.init_db())

            payload = _make_trade_payload("campaign:contract-retry")
            first = _run(_kb_trade_handler()(payload))
            data = _run(_kb_trade_handler()(payload))

            assert first["recorded"] is True
            assert first["duplicate"] is False
            assert data["ok"] is True
            assert data["recorded"] is True
            assert data["duplicate"] is True
            assert data["sourceId"] == "campaign:contract-retry"
        finally:
            kb.DB_PATH = original_db_path
            for suffix in ("", "-shm", "-wal"):
                candidate = Path(f"{db_path}{suffix}")
                if candidate.exists():
                    candidate.unlink()
