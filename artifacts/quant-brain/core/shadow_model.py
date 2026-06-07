from __future__ import annotations

import json
import time
import math
import os
from pathlib import Path
from typing import Any
from collections import defaultdict

from core import knowledge_base as kb


MODEL_DIR = Path(__file__).parent.parent / "data" / "models"
MODEL_PATH = MODEL_DIR / "sniper_target_050.joblib"
METADATA_PATH = MODEL_DIR / "sniper_target_050.json"
MIN_TRAINING_SAMPLES = 300

# Constantes para features
CATEGORICAL_FEATURES = [
    "alt_movement_state",
    "btc_movement_state",
    "alt_1m_breakout",
    "alt_5m_breakout",
    "alt_15m_breakout",
    "btc_candle_bias",
    "btc_candle_action",
    "btc_1h_trend",
    "btc_4h_trend",
]
NUMERICAL_FEATURES = [
    "alt_price_change_pct",
    "alt_price_acceleration",
    "alt_volume_ratio",
    "alt_oi_change_pct",
    "alt_funding_rate",
    "alt_rsi",
    "alt_atr_pct",
    "alt_spread_bps",
    "btc_price_change_pct",
    "btc_price_acceleration",
    "btc_volume_ratio",
    "btc_oi_change_pct",
    "btc_funding_rate",
    "btc_rsi",
    "btc_atr_pct",
    "btc_spread_bps",
    "target_move_pct",
    "estimated_cost_pct",
    "alt_1m_changePct",
    "alt_1m_emaDistancePct",
    "alt_1m_rangePct",
    "alt_1m_wickRatio",
    "alt_1m_volumeRatioAvg",
    "alt_5m_changePct",
    "alt_5m_emaDistancePct",
    "alt_5m_rangePct",
    "alt_5m_wickRatio",
    "alt_5m_volumeRatioAvg",
    "alt_15m_changePct",
    "alt_15m_emaDistancePct",
    "alt_15m_rangePct",
    "alt_15m_wickRatio",
    "alt_15m_volumeRatioAvg",
    "btc_correction_risk",
    "btc_trend_score",
    "btc_1h_move_pct",
    "btc_4h_move_pct",
    "btc_1h_volume_ratio",
    "btc_4h_volatility_pct",
]

# Feature importance tracking
_feature_importance_cache: dict[str, float] = {}


def _feature_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Converte row em dicionário de features para o modelo."""
    features = row.get("features", {})
    alt = features.get("alt", {})
    btc = features.get("btc", {})
    alt_frames = features.get("alt_timeframes", {})
    candle_regime = features.get("candle_regime", {})

    result: dict[str, Any] = {
        "symbol": row.get("symbol", ""),
        "side": row.get("side", ""),
        "context_key": row.get("context_key", ""),
        "decision_group": row.get("decision_group", "UNKNOWN"),
        "target_move_pct": float(row.get("target_configured_move_pct", 0) or 0),
        "estimated_cost_pct": float(row.get("estimated_cost_pct", 0) or 0),
    }

    # Features do alt e btc
    for prefix, source in (("alt", alt), ("btc", btc)):
        for key in NUMERICAL_FEATURES:
            if key.startswith(prefix) and not key.startswith("btc_correction") and not key.startswith("btc_trend") and not key.startswith("btc_1h") and not key.startswith("btc_4h"):
                feature_name = key.replace(f"{prefix}_", "")
                result[key] = float(source.get(feature_name, 0) or 0)
        result[f"{prefix}_movement_state"] = str(source.get("movement_state", "NO_DATA"))

    # Features de timeframe
    for frame_name in ("1m", "5m", "15m"):
        frame = alt_frames.get(frame_name, {})
        for key in ("changePct", "emaDistancePct", "rangePct", "wickRatio", "volumeRatioAvg"):
            result[f"alt_{frame_name}_{key}"] = float(frame.get(key, 0) or 0)
        result[f"alt_{frame_name}_breakout"] = str(frame.get("breakoutState", "NO_DATA"))

    # Features de candle regime macro (1h/4h/1d contexto BTC)
    tf_1h = candle_regime.get("1h", {})
    tf_4h = candle_regime.get("4h", {})
    result["btc_candle_bias"] = str(candle_regime.get("bias", "NEUTRAL"))
    result["btc_candle_action"] = str(candle_regime.get("action", "RANGE_ONLY"))
    result["btc_1h_trend"] = str(tf_1h.get("trend", "NEUTRAL"))
    result["btc_4h_trend"] = str(tf_4h.get("trend", "NEUTRAL"))
    result["btc_correction_risk"] = float(candle_regime.get("correctionRisk", 0) or 0)
    result["btc_trend_score"] = float(candle_regime.get("trendScore", 0) or 0)
    result["btc_1h_move_pct"] = float(tf_1h.get("movePct", 0) or 0)
    result["btc_4h_move_pct"] = float(tf_4h.get("movePct", 0) or 0)
    result["btc_1h_volume_ratio"] = float(tf_1h.get("volumeRatio", 1) or 1)
    result["btc_4h_volatility_pct"] = float(tf_4h.get("volatilityPct", 0) or 0)

    # Features derivadas (interações)
    result["alt_btc_momentum_ratio"] = (
        result.get("alt_price_change_pct", 0) / max(0.01, abs(result.get("btc_price_change_pct", 0.01)))
    )
    result["alt_volume_oi_interaction"] = (
        result.get("alt_volume_ratio", 1) * (1 + max(0, result.get("alt_oi_change_pct", 0) / 100))
    )
    result["rsi_extreme"] = 1 if result.get("alt_rsi", 50) > 75 or result.get("alt_rsi", 50) < 25 else 0
    result["spread_penalty"] = min(1.0, result.get("alt_spread_bps", 0) / 20)
    result["regime_aligned"] = 1 if (
        (row.get("side", "") == "LONG" and result["btc_candle_bias"] == "LONG") or
        (row.get("side", "") == "SHORT" and result["btc_candle_bias"] == "SHORT")
    ) else 0

    return result


def _calculate_feature_importance(model, vectorizer, feature_names: list[str]) -> dict[str, float]:
    """Calcula feature importance do modelo treinado."""
    try:
        # Extrai importância do RandomForest
        if hasattr(model.named_steps["classifier"], "feature_importances_"):
            importances = model.named_steps["classifier"].feature_importances_

            # Mapeia nomes das features
            feature_names_from_vec = vectorizer.get_feature_names_out()
            importance_dict = {}
            for name, imp in zip(feature_names_from_vec, importances):
                importance_dict[name] = float(imp)

            # Ordena e retorna top 20
            sorted_imp = sorted(importance_dict.items(), key=lambda x: x[1], reverse=True)
            return dict(sorted_imp[:20])
    except Exception:
        pass

    return {}


def _cross_validate_temporal(
    x: list[dict],
    y: list[int],
    n_folds: int = 5,
) -> dict[str, Any]:
    """
    Validação cruzada temporal (walk-forward) mais robusta.
    Não vaza dados do futuro.
    """
    try:
        import numpy as np
        from sklearn.ensemble import GradientBoostingClassifier
        from sklearn.feature_extraction import DictVectorizer
        from sklearn.metrics import brier_score_loss, roc_auc_score
        from sklearn.pipeline import Pipeline
    except ImportError:
        return {"success": False, "reason": "import_error"}

    n = len(x)
    fold_size = n // n_folds
    cv_results = []

    for fold in range(n_folds - 1):
        train_end = (fold + 1) * fold_size
        test_start = train_end
        test_end = min(test_start + fold_size, n)

        if train_end < 50 or test_start >= n:
            continue

        x_train = x[:train_end]
        y_train = y[:train_end]
        x_test = x[test_start:test_end]
        y_test = y[test_start:test_end]

        if len(set(y_train)) < 2 or len(set(y_test)) < 2:
            continue

        # Treina modelo
        pipeline = Pipeline([
            ("vectorizer", DictVectorizer(sparse=False)),
            ("classifier", GradientBoostingClassifier(
                n_estimators=200,
                learning_rate=0.05,
                max_depth=4,
                min_samples_leaf=10,
                subsample=0.8,
                random_state=42,
            )),
        ])

        pipeline.fit(x_train, y_train)
        y_pred_proba = pipeline.predict_proba(x_test)[:, 1]

        brier = brier_score_loss(y_test, y_pred_proba)
        auc = roc_auc_score(y_test, y_pred_proba) if len(set(y_test)) > 1 else 0.5

        cv_results.append({
            "fold": fold,
            "train_samples": len(x_train),
            "test_samples": len(x_test),
            "brier": round(brier, 6),
            "auc": round(auc, 6),
        })

    if not cv_results:
        return {"success": False, "reason": "no_valid_folds"}

    avg_brier = sum(r["brier"] for r in cv_results) / len(cv_results)
    avg_auc = sum(r["auc"] for r in cv_results) / len(cv_results)

    return {
        "success": True,
        "n_folds": len(cv_results),
        "avg_brier": round(avg_brier, 6),
        "avg_auc": round(avg_auc, 6),
        "results": cv_results,
    }


async def train_shadow_model(min_samples: int = MIN_TRAINING_SAMPLES) -> dict[str, Any]:
    """Treina modelo shadow com validação avançada e early stopping."""
    try:
        import joblib
        import numpy as np
        from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
        from sklearn.feature_extraction import DictVectorizer
        from sklearn.isotonic import IsotonicRegression
        from sklearn.metrics import brier_score_loss, roc_auc_score, log_loss
        from sklearn.pipeline import Pipeline
        from sklearn.calibration import CalibratedClassifierCV
    except ImportError as exc:
        return {"trained": False, "reason": f"ml_dependencies_missing: {exc}"}

    source_filter = os.environ.get("SHADOW_MODEL_SIGNAL_SOURCE_TYPE", "").strip() or None
    rows = await kb.get_signal_training_rows(decision_group=None, source_type=source_filter)
    if len(rows) < min_samples:
        return {
            "trained": False,
            "reason": "insufficient_samples",
            "samples": len(rows),
            "minSamples": min_samples,
        }

    x = [_feature_dict(row) for row in rows]
    y = np.asarray([int(row.get("hit_configured") or 0) for row in rows])

    # Divisão temporal (não aleatória)
    split = max(int(len(rows) * 0.8), 1)
    if len(set(y[:split])) < 2 or len(set(y[split:])) < 2:
        return {"trained": False, "reason": "both_classes_required", "samples": len(rows)}

    def build_gb_model() -> Pipeline:
        """Gradient Boosting com regularização."""
        return Pipeline([
            ("vectorizer", DictVectorizer(sparse=False)),
            ("classifier", GradientBoostingClassifier(
                n_estimators=300,
                learning_rate=0.03,
                max_depth=4,
                min_samples_leaf=8,
                subsample=0.7,
                random_state=42,
            )),
        ])

    def build_rf_model() -> Pipeline:
        """Random Forest com regularização."""
        return Pipeline([
            ("vectorizer", DictVectorizer(sparse=True)),
            ("classifier", RandomForestClassifier(
                n_estimators=500,
                max_depth=8,
                min_samples_leaf=6,
                class_weight="balanced_subsample",
                random_state=42,
                n_jobs=-1,
            )),
        ])

    # Expanding-window out-of-fold predictions
    oof_probabilities: list[float] = []
    oof_labels: list[int] = []
    fold_edges = [int(split * ratio) for ratio in (0.3, 0.5, 0.7, 0.85, 1.0)]

    for train_end, validation_end in zip(fold_edges, fold_edges[1:]):
        if train_end < 50 or validation_end <= train_end:
            continue
        fold_y = y[:train_end]
        if len(set(fold_y)) < 2:
            continue

        # Treina ambos modelos e ensembla
        gb_model = build_gb_model()
        rf_model = build_rf_model()

        gb_model.fit(x[:train_end], fold_y)
        rf_model.fit(x[:train_end], fold_y)

        gb_proba = gb_model.predict_proba(x[train_end:validation_end])[:, 1]
        rf_proba = rf_model.predict_proba(x[train_end:validation_end])[:, 1]

        # Ensemble simples (média)
        ensemble_proba = (gb_proba + rf_proba) / 2

        oof_probabilities.extend(float(p) for p in ensemble_proba)
        oof_labels.extend(int(v) for v in y[train_end:validation_end])

    if len(oof_probabilities) < 50 or len(set(oof_labels)) < 2:
        return {"trained": False, "reason": "insufficient_walk_forward_folds"}

    # Calibração isotônica
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(oof_probabilities, oof_labels)

    # Treina modelo final com ensemble
    gb_final = build_gb_model()
    rf_final = build_rf_model()

    gb_final.fit(x[:split], y[:split])
    rf_final.fit(x[:split], y[:split])

    # Avaliação no test set
    gb_test = gb_final.predict_proba(x[split:])[:, 1]
    rf_test = rf_final.predict_proba(x[split:])[:, 1]
    ensemble_test = (gb_test + rf_test) / 2
    calibrated_test = calibrator.predict(ensemble_test)

    baseline_probability = float(y[:split].mean())
    baseline = np.full(len(y[split:]), baseline_probability)

    model_brier = float(brier_score_loss(y[split:], calibrated_test))
    baseline_brier = float(brier_score_loss(y[split:], baseline))
    model_log_loss = float(log_loss(y[split:], calibrated_test))
    auc = float(roc_auc_score(y[split:], calibrated_test))
    improves_baseline = model_brier < baseline_brier

    # Validação cruzada temporal
    cv_results = _cross_validate_temporal(x, y)

    # Feature importance
    feature_importance = _calculate_feature_importance(gb_final, gb_final.named_steps["vectorizer"], NUMERICAL_FEATURES)
    _feature_importance_cache.update(feature_importance)

    metadata = {
        "trainedAt": time.time(),
        "samples": len(rows),
        "trainSamples": split,
        "testSamples": len(rows) - split,
        "modelBrier": round(model_brier, 6),
        "baselineBrier": round(baseline_brier, 6),
        "modelLogLoss": round(model_log_loss, 6),
        "rocAuc": round(auc, 6),
        "improvesBaseline": improves_baseline,
        "authority": "shadow_ensemble",
        "target": "0.5",
        "cvResults": cv_results if cv_results.get("success") else None,
        "topFeatures": list(feature_importance.keys())[:10] if feature_importance else [],
    }

    if improves_baseline:
        # Ensemble final (média dos dois modelos)
        final_model = {
            "gb_model": gb_final,
            "rf_model": rf_final,
            "calibrator": calibrator,
            "model_type": "ensemble",
        }
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        joblib.dump(final_model, MODEL_PATH)
        METADATA_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        await kb.save_model_artifact(
            "sniper_target_050",
            MODEL_PATH.read_bytes(),
            metadata,
        )

    return {"trained": improves_baseline, **metadata}


async def restore_shadow_model() -> bool:
    if MODEL_PATH.exists() and METADATA_PATH.exists():
        return True
    artifact = await kb.get_model_artifact("sniper_target_050")
    if not artifact:
        return False
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_PATH.write_bytes(artifact["content"])
    METADATA_PATH.write_text(
        json.dumps(artifact["metadata"], indent=2),
        encoding="utf-8",
    )
    return True


def shadow_model_status() -> dict[str, Any]:
    """Retorna status do modelo shadow com métricas."""
    if not MODEL_PATH.exists() or not METADATA_PATH.exists():
        return {"available": False, "authority": "shadow"}

    metadata = json.loads(METADATA_PATH.read_text(encoding="utf-8"))

    # Adiciona avaliação de qualidade
    quality = "poor"
    if metadata.get("rocAuc", 0) > 0.65:
        quality = "good"
    elif metadata.get("rocAuc", 0) > 0.6:
        quality = "acceptable"

    if metadata.get("improvesBaseline", False):
        quality = "good" if quality == "good" else "acceptable"

    return {
        "available": True,
        "quality": quality,
        **metadata,
    }


def predict_shadow(row: dict[str, Any]) -> dict[str, Any]:
    """
    Predição com ensemble de modelos.
    Retorna probabilidade calibrada e interpretabilidade.
    """
    if not MODEL_PATH.exists():
        return {"available": False, "authority": "shadow"}

    try:
        import joblib
        import numpy as np
    except ImportError:
        return {"available": False, "authority": "shadow", "reason": "joblib_missing"}

    try:
        bundle = joblib.load(MODEL_PATH)
        features = _feature_dict(row)

        # Ensemble prediction
        if isinstance(bundle, dict) and bundle.get("model_type") == "ensemble":
            gb_proba = bundle["gb_model"].predict_proba([features])[0][1]
            rf_proba = bundle["rf_model"].predict_proba([features])[0][1]
            ensemble_proba = (float(gb_proba) + float(rf_proba)) / 2
            calibrated = float(bundle["calibrator"].predict([ensemble_proba])[0])
        else:
            # Fallback para modelo antigo
            raw = float(bundle["model"].predict_proba([features])[0][1])
            calibrated = float(bundle["calibrator"].predict([raw])[0])

        # Nível de confiança baseado na distância do 0.5
        confidence = min(0.95, abs(calibrated - 0.5) * 2)

        # Interpretação
        if calibrated >= 0.65:
            verdict = "STRONG_POSITIVE"
        elif calibrated >= 0.55:
            verdict = "POSITIVE"
        elif calibrated >= 0.45:
            verdict = "NEUTRAL"
        elif calibrated >= 0.35:
            verdict = "NEGATIVE"
        else:
            verdict = "STRONG_NEGATIVE"

        return {
            "available": True,
            "authority": "shadow_ensemble",
            "rawProbability": round(ensemble_proba if 'ensemble_proba' in dir() else raw, 6),
            "calibratedProbability": round(calibrated, 6),
            "confidence": round(confidence, 3),
            "verdict": verdict,
            "recommendation": "ALLOW" if calibrated >= 0.55 else "BLOCK" if calibrated <= 0.45 else "UNCERTAIN",
        }

    except Exception as e:
        return {
            "available": True,
            "authority": "shadow",
            "error": str(e),
            "calibratedProbability": 0.5,
            "verdict": "ERROR_FALLBACK",
        }


def get_feature_importance() -> dict[str, float]:
    """Retorna feature importance do último modelo treinado."""
    return _feature_importance_cache.copy()


async def evaluate_model_performance() -> dict[str, Any]:
    """Avalia performance do modelo em dados recentes."""
    try:
        import joblib
        import numpy as np
        from sklearn.metrics import brier_score_loss, roc_auc_score
    except ImportError:
        return {"success": False, "reason": "import_error"}

    if not MODEL_PATH.exists():
        return {"success": False, "reason": "model_not_found"}

    rows = await kb.get_signal_training_rows(decision_group=None)
    if len(rows) < 100:
        return {"success": False, "reason": "insufficient_samples"}

    # Usa últimos 20% como teste
    split = int(len(rows) * 0.8)
    test_rows = rows[split:]

    if len(test_rows) < 50:
        return {"success": False, "reason": "insufficient_test_samples"}

    try:
        bundle = joblib.load(MODEL_PATH)
        predictions = []
        actuals = []

        for row in test_rows:
            features = _feature_dict(row)

            if isinstance(bundle, dict) and bundle.get("model_type") == "ensemble":
                gb_proba = bundle["gb_model"].predict_proba([features])[0][1]
                rf_proba = bundle["rf_model"].predict_proba([features])[0][1]
                ensemble_proba = (float(gb_proba) + float(rf_proba)) / 2
                proba = float(bundle["calibrator"].predict([ensemble_proba])[0])
            else:
                raw = float(bundle["model"].predict_proba([features])[0][1])
                proba = float(bundle["calibrator"].predict([raw])[0])

            predictions.append(proba)
            actuals.append(int(row.get("hit_configured") or 0))

        brier = brier_score_loss(actuals, predictions)
        auc = roc_auc_score(actuals, predictions) if len(set(actuals)) > 1 else 0.5

        return {
            "success": True,
            "test_samples": len(test_rows),
            "brier_score": round(brier, 6),
            "roc_auc": round(auc, 6),
            "calibration_error": round(abs(sum(predictions) / len(predictions) - sum(actuals) / len(actuals)), 4),
        }
    except Exception as e:
        return {"success": False, "reason": str(e)}
