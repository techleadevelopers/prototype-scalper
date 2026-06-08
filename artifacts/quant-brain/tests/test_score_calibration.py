from core.score_calibration import run_score_calibration


def _rows():
    rows = []
    for index in range(240):
        score = 0.52 + (index % 9) * 0.055
        pnl = 1.0 if (index % 100) / 100 <= score - 0.18 else -0.7
        rows.append({
            "signalId": f"sig-{index}",
            "symbol": "BTC-USDT" if index % 2 else "ETH-USDT",
            "side": "LONG" if index % 2 else "SHORT",
            "aggressiveScore": score,
            "executionPriority": score,
            "coachScore": score * 0.95,
            "playbookScore": score * 0.90,
            "playbook": "breakout" if index % 3 else "fade",
            "regime": "BULL" if index % 2 else "BEAR",
            "mlProbability": score,
            "realizedPnl": pnl,
            "exitReason": "TP" if pnl > 0 else "SL",
            "mfePct": score * 0.4,
            "maePct": -(1 - score) * 0.2,
            "slippageBps": 2.0,
            "latencyDragUsdt": 0.01,
            "timestamp": float(index),
        })
    return rows


def test_score_calibration_reports_truth_and_thresholds():
    report = run_score_calibration(_rows())
    assert report["samples"] == 240
    assert report["scoreTruth"]["calibrationQuality"] in {"GOOD", "OK", "WEAK", "BAD"}
    assert report["bestScoringModel"] in report["models"]
    assert len(report["buckets"]) == 9
    assert report["recommendedThresholds"]["learningSafety"]["level"] == "MODERATE"
    assert "scoreVsActualPnlChartData" in report


def test_score_calibration_observe_only_under_50_trades():
    report = run_score_calibration(_rows()[:30])
    assert report["recommendedThresholds"]["learningSafety"]["level"] == "OBSERVE"
    assert report["recommendedThresholds"]["learningSafety"]["canAutoAdjust"] is False
    assert "learning_safety_observe_only" in report["overconfidenceWarnings"]
