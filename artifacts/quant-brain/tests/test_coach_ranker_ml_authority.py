from core.coach_ranker import compute_aggressive_score


def _base_inputs(shadow_ml):
    return {
        "sniper": {
            "score": 0.62,
            "candleScore": 0.62,
            "altFeatures": {"volume_ratio": 1.0, "oi_change_pct": 0.0},
            "btcFeatures": {"price_change_pct": 0.1},
        },
        "signal_edge": {"score": 0.5, "symbolSide": {"samples": 10}},
        "shadow_ml": shadow_ml,
        "btc_regime": "BULL",
        "data_quality": {
            "alt1m": {"coveragePct": 1.0},
            "alt5m": {"coveragePct": 1.0},
            "btc1m": {"coveragePct": 1.0},
        },
        "position_side": "LONG",
    }


def test_calibrated_shadow_ml_gets_more_than_legacy_authority(monkeypatch):
    monkeypatch.setenv("COACH_SHADOW_ML_MAX_WEIGHT", "0.30")
    cold = compute_aggressive_score(**_base_inputs({"available": False}))
    strong = compute_aggressive_score(**_base_inputs({
        "available": True,
        "calibratedProbability": 0.90,
        "samples": 422,
        "modelBrier": 0.1303,
        "rocAuc": 0.77,
        "profitabilityVerified": True,
        "uncertaintyType": "STRONG_EVIDENCE",
    }))

    assert strong - cold > 0.07
