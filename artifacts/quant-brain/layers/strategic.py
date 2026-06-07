"""
Camada Estratégica — analisa 1.000/5.000/10.000 trades e semanas/meses de histórico.
Detecta mudanças estruturais de edge, evolução de win rate por símbolo e lado.
Nível WAR: Sharpe, Sortino, Calmar, significância estatística, regime-switching,
backtest walk-forward, detecção de overfitting, bootstrap de confiança.
"""
from __future__ import annotations

import asyncio
import time
import logging
import math
import random
from dataclasses import dataclass, field
from typing import Optional, Any

from core import knowledge_base as kb
from core.database import Row, connect

log = logging.getLogger("strategic")

SYMBOLS_SHORT = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "VVVUSDT", "TRUMPUSDT",
    "MELANIAUSDT", "BEATUSDT", "NEARUSDT", "HYPEUSDT", "POLUSDT",
]


@dataclass
class EdgeEvolution:
    symbol: str
    side: str
    period_label: str
    win_rate_early: float
    win_rate_late: float
    delta_wr: float
    avg_pnl_early: float
    avg_pnl_late: float
    delta_pnl: float
    trades_early: int
    trades_late: int
    trend: str   # IMPROVING / DETERIORATING / STABLE


@dataclass
class StrategicReport:
    period_days: int
    generated_at: float
    total_trades: int
    global_win_rate: float
    top_performers: list[dict]
    worst_performers: list[dict]
    edge_migrations: list[EdgeEvolution]
    structural_changes: list[str]
    raw_stats: dict
    # NOVOS CAMPOS PARA NÍVEL WAR
    risk_metrics: dict = field(default_factory=dict)
    statistical_tests: dict = field(default_factory=dict)
    regime_performance: dict = field(default_factory=dict)
    walk_forward_validation: dict = field(default_factory=dict)
    bootstrap_confidence: dict = field(default_factory=dict)
    pnl_attribution: dict = field(default_factory=dict)


# ========== FUNÇÕES DE MÉTRICAS AJUSTADAS POR RISCO ==========

def _calculate_sharpe_ratio(returns: list[float], risk_free_rate: float = 0.0) -> dict:
    """
    Calcula Sharpe Ratio anualizado.
    Sharpe > 1 é bom, > 2 é excelente, > 3 é elite.
    """
    if len(returns) < 3:
        return {"sharpe": 0.0, "annualized_sharpe": 0.0, "samples": len(returns)}

    mean_return = sum(returns) / len(returns)
    variance = sum((r - mean_return) ** 2 for r in returns) / len(returns)
    std_return = math.sqrt(variance) if variance > 0 else 0.0001

    if std_return == 0:
        return {"sharpe": 0.0, "annualized_sharpe": 0.0, "samples": len(returns)}

    sharpe = (mean_return - risk_free_rate) / std_return

    # Anualização (assumindo 252 dias de trading, ~6.5 horas por dia para crypto)
    # Para crypto 24/7, usa-se 365
    annualized_sharpe = sharpe * math.sqrt(365)

    # Classificação
    if annualized_sharpe >= 3.0:
        rating = "ELITE"
    elif annualized_sharpe >= 2.0:
        rating = "EXCELLENT"
    elif annualized_sharpe >= 1.0:
        rating = "GOOD"
    elif annualized_sharpe >= 0.5:
        rating = "ACCEPTABLE"
    else:
        rating = "POOR"

    return {
        "sharpe": round(sharpe, 4),
        "annualized_sharpe": round(annualized_sharpe, 3),
        "rating": rating,
        "samples": len(returns),
        "mean_return_pct": round(mean_return * 100, 4),
        "volatility_pct": round(std_return * 100, 4)
    }


def _calculate_sortino_ratio(returns: list[float], risk_free_rate: float = 0.0) -> dict:
    """
    Calcula Sortino Ratio (só penaliza downside deviation).
    Melhor que Sharpe para estratégias assimétricas.
    """
    if len(returns) < 3:
        return {"sortino": 0.0, "annualized_sortino": 0.0, "samples": len(returns)}

    mean_return = sum(returns) / len(returns)

    # Downside deviation (só retornos negativos)
    negative_returns = [r for r in returns if r < 0]
    if not negative_returns:
        downside_std = 0.0001  # Evitar divisão por zero
    else:
        downside_var = sum((r - mean_return) ** 2 for r in negative_returns) / len(returns)
        downside_std = math.sqrt(downside_var) if downside_var > 0 else 0.0001

    sortino = (mean_return - risk_free_rate) / downside_std
    annualized_sortino = sortino * math.sqrt(365)

    if annualized_sortino >= 3.0:
        rating = "ELITE"
    elif annualized_sortino >= 2.0:
        rating = "EXCELLENT"
    elif annualized_sortino >= 1.0:
        rating = "GOOD"
    else:
        rating = "POOR"

    return {
        "sortino": round(sortino, 4),
        "annualized_sortino": round(annualized_sortino, 3),
        "rating": rating,
        "samples": len(returns),
        "downside_volatility_pct": round(downside_std * 100, 4)
    }


def _calculate_calmar_ratio(returns: list[float], max_drawdown_pct: float = None) -> dict:
    """
    Calcula Calmar Ratio = retorno anualizado / max drawdown.
    Essencial para estratégias de scalping.
    """
    if len(returns) < 5:
        return {"calmar": 0.0, "rating": "INSUFFICIENT_DATA", "samples": len(returns)}

    # Calcula drawdown se não fornecido
    if max_drawdown_pct is None:
        cumulative = 0.0
        peak = 0.0
        max_drawdown = 0.0
        for r in returns:
            cumulative += r
            if cumulative > peak:
                peak = cumulative
            drawdown = peak - cumulative
            if drawdown > max_drawdown:
                max_drawdown = drawdown
        max_drawdown_pct = max_drawdown * 100

    if max_drawdown_pct <= 0:
        return {"calmar": 999.0, "rating": "INFINITE", "max_drawdown_pct": 0.0}

    total_return = sum(returns) * 100  # em percentual
    annualized_return = total_return / (len(returns) / 365) if len(returns) > 0 else 0

    calmar = annualized_return / max_drawdown_pct if max_drawdown_pct > 0 else 0

    if calmar >= 5.0:
        rating = "ELITE"
    elif calmar >= 3.0:
        rating = "EXCELLENT"
    elif calmar >= 1.5:
        rating = "GOOD"
    elif calmar >= 0.5:
        rating = "ACCEPTABLE"
    else:
        rating = "POOR"

    return {
        "calmar": round(calmar, 3),
        "rating": rating,
        "max_drawdown_pct": round(max_drawdown_pct, 2),
        "annualized_return_pct": round(annualized_return, 2),
        "samples": len(returns)
    }


def _calculate_profit_factor(returns: list[float]) -> dict:
    """Profit Factor: lucro bruto / prejuízo bruto."""
    gross_profit = sum(r for r in returns if r > 0)
    gross_loss = abs(sum(r for r in returns if r < 0))

    if gross_loss == 0:
        profit_factor = 999.0 if gross_profit > 0 else 0.0
        rating = "INFINITE" if gross_profit > 0 else "NO_TRADES"
    else:
        profit_factor = gross_profit / gross_loss

    if profit_factor >= 2.0:
        rating = "EXCELLENT"
    elif profit_factor >= 1.5:
        rating = "GOOD"
    elif profit_factor >= 1.2:
        rating = "ACCEPTABLE"
    elif profit_factor >= 1.0:
        rating = "MARGINAL"
    else:
        rating = "NEGATIVE_EDGE"

    return {
        "profit_factor": round(profit_factor, 3),
        "rating": rating,
        "gross_profit": round(gross_profit, 4),
        "gross_loss": round(gross_loss, 4)
    }


def _calculate_expectancy(returns: list[float]) -> dict:
    """
    Expectancy por trade em USDT.
    A métrica mais importante para PnL real.
    """
    if not returns:
        return {"expectancy": 0.0, "rating": "NO_DATA"}

    avg_win = sum(r for r in returns if r > 0) / max(1, len([r for r in returns if r > 0]))
    avg_loss = sum(r for r in returns if r < 0) / max(1, len([r for r in returns if r < 0]))
    win_rate = len([r for r in returns if r > 0]) / len(returns)
    loss_rate = 1 - win_rate

    expectancy = (win_rate * avg_win) + (loss_rate * avg_loss)

    # Em percentual do risco médio
    avg_risk = abs(avg_loss) if avg_loss != 0 else 0.01
    expectancy_ratio = expectancy / avg_risk if avg_risk > 0 else 0

    if expectancy_ratio >= 0.5:
        rating = "ELITE"
    elif expectancy_ratio >= 0.3:
        rating = "EXCELLENT"
    elif expectancy_ratio >= 0.15:
        rating = "GOOD"
    elif expectancy_ratio >= 0.05:
        rating = "ACCEPTABLE"
    elif expectancy_ratio > 0:
        rating = "MARGINAL"
    else:
        rating = "NEGATIVE"

    return {
        "expectancy_usdt": round(expectancy, 4),
        "expectancy_ratio": round(expectancy_ratio, 3),
        "rating": rating,
        "avg_win_usdt": round(avg_win, 4),
        "avg_loss_usdt": round(avg_loss, 4),
        "win_rate": round(win_rate * 100, 1)
    }


def _calculate_max_drawdown(returns: list[float]) -> dict:
    """Calcula maximum drawdown e duration."""
    if len(returns) < 2:
        return {"max_drawdown_pct": 0.0, "duration_days": 0.0}

    cumulative = 0.0
    peak = 0.0
    max_drawdown = 0.0
    drawdown_start = None
    max_drawdown_start = None
    max_drawdown_end = None

    for i, r in enumerate(returns):
        cumulative += r
        if cumulative > peak:
            peak = cumulative
            drawdown_start = None
        else:
            if drawdown_start is None:
                drawdown_start = i
            drawdown = peak - cumulative
            if drawdown > max_drawdown:
                max_drawdown = drawdown
                max_drawdown_start = drawdown_start
                max_drawdown_end = i

    max_drawdown_pct = max_drawdown * 100
    duration_days = (max_drawdown_end - max_drawdown_start) if max_drawdown_start is not None else 0

    if max_drawdown_pct <= 1:
        rating = "EXCELLENT"
    elif max_drawdown_pct <= 3:
        rating = "GOOD"
    elif max_drawdown_pct <= 7:
        rating = "ACCEPTABLE"
    elif max_drawdown_pct <= 15:
        rating = "HIGH"
    else:
        rating = "CRITICAL"

    return {
        "max_drawdown_pct": round(max_drawdown_pct, 2),
        "duration_trades": max_drawdown_end - max_drawdown_start if max_drawdown_start else 0,
        "rating": rating,
        "recovery_required_pct": round(max_drawdown_pct / (1 - max_drawdown_pct/100) * 100 if max_drawdown_pct < 100 else 0, 2)
    }


def _calculate_win_rate_confidence(returns: list[float], confidence_level: float = 0.95) -> dict:
    """
    Intervalo de confiança para win rate usando bootstrap.
    Crucial para saber se edge é real ou sorte.
    """
    if len(returns) < 10:
        return {
            "observed_win_rate": 0.0,
            "lower_bound_95": 0.0,
            "upper_bound_95": 100.0,
            "margin_error_pp": 50.0,
            "statistically_significant": False,
            "verdict": "INSUFFICIENT_EVIDENCE",
            "samples": len(returns),
            "reliable": False,
        }

    wins = [1 if r > 0 else 0 for r in returns]
    n_bootstrap = 1000
    bootstrap_wrs = []

    for _ in range(n_bootstrap):
        sample = [random.choice(wins) for _ in range(len(wins))]
        bootstrap_wrs.append(sum(sample) / len(sample))

    bootstrap_wrs.sort()
    alpha = 1 - confidence_level
    lower_idx = int(n_bootstrap * alpha / 2)
    upper_idx = int(n_bootstrap * (1 - alpha / 2))

    lower_bound = bootstrap_wrs[lower_idx]
    upper_bound = bootstrap_wrs[upper_idx]
    observed_wr = sum(wins) / len(wins)
    margin_error = (upper_bound - lower_bound) / 2

    # Se o intervalo não contém 0.5, edge é estatisticamente significativo
    significant = lower_bound > 0.5 or upper_bound < 0.5
    # Se contém 0.5, pode ser sorte
    contains_no_edge = lower_bound <= 0.5 <= upper_bound

    if significant and observed_wr > 0.55:
        verdict = "POSITIVE_EDGE_CONFIRMED"
    elif significant and observed_wr < 0.45:
        verdict = "NEGATIVE_EDGE_CONFIRMED"
    elif contains_no_edge:
        verdict = "INCONCLUSIVE_MAYBE_LUCK"
    else:
        verdict = "INSUFFICIENT_EVIDENCE"

    return {
        "observed_win_rate": round(observed_wr * 100, 1),
        "lower_bound_95": round(lower_bound * 100, 1),
        "upper_bound_95": round(upper_bound * 100, 1),
        "margin_error_pp": round(margin_error * 100, 1),
        "statistically_significant": significant,
        "verdict": verdict,
        "samples": len(returns),
        "reliable": len(returns) >= 30
    }


def _calculate_t_test_vs_random(returns: list[float], null_wr: float = 0.5) -> dict:
    """
    Teste t para verificar se win rate é diferente de 50% (aleatório).
    """
    if len(returns) < 10:
        return {
            "p_value": 1.0,
            "t_statistic": 0.0,
            "significant_95": False,
            "significant_99": False,
            "samples": len(returns),
            "interpretation": "Insufficient evidence",
        }

    wins = [1 if r > 0 else 0 for r in returns]
    n = len(wins)
    observed_wr = sum(wins) / n
    std_error = math.sqrt(null_wr * (1 - null_wr) / n)

    if std_error == 0:
        t_stat = 0
    else:
        t_stat = (observed_wr - null_wr) / std_error

    # Aproximação normal para p-value (para n > 30 é boa)
    from math import erf
    p_value = 0.5 * (1 + erf(t_stat / math.sqrt(2))) if t_stat >= 0 else 0.5 * (1 + erf(-t_stat / math.sqrt(2)))
    p_value = 2 * min(p_value, 1 - p_value)  # Two-tailed

    significant = p_value < 0.05

    return {
        "p_value": round(p_value, 6),
        "t_statistic": round(t_stat, 4),
        "significant_95": significant,
        "significant_99": p_value < 0.01,
        "samples": n,
        "interpretation": "Edge is statistically significant" if significant and observed_wr > 0.5 else "Cannot reject null hypothesis" if not significant else "Negative edge statistically significant"
    }


def _detect_regime_switch(performance_by_regime: dict) -> dict:
    """
    Detecta se o edge mudou entre regimes de mercado (BULL/BEAR/NEUTRAL).
    Crucial para saber se estratégia quebrou após mudança de mercado.
    """
    switches = []
    regime_stats = {}

    for symbol, regimes in performance_by_regime.items():
        regime_stats[symbol] = {}
        for regime in ["BULL", "BEAR", "NEUTRAL"]:
            regime_data = regimes.get(regime, {})
            wr = regime_data.get("win_rate", 0)
            trades = regime_data.get("trades", 0)
            avg_pnl = regime_data.get("avg_pnl", 0)
            regime_stats[symbol][regime] = {"win_rate": wr, "trades": trades, "avg_pnl": avg_pnl}

            if trades >= 5:
                # Compara com outros regimes
                for other_regime in ["BULL", "BEAR", "NEUTRAL"]:
                    if other_regime == regime:
                        continue
                    other_wr = regimes.get(other_regime, {}).get("win_rate", 0)
                    other_trades = regimes.get(other_regime, {}).get("trades", 0)

                    if other_trades >= 5:
                        diff = abs(wr - other_wr)
                        if diff > 15:  # 15 pontos percentuais de diferença
                            switches.append({
                                "symbol": symbol,
                                "regime": regime,
                                "win_rate": round(wr, 1),
                                "other_regime": other_regime,
                                "other_win_rate": round(other_wr, 1),
                                "diff_pp": round(diff, 1),
                                "recommendation": f"TRADE_ONLY_{regime}" if wr > other_wr else f"AVOID_{regime}"
                            })

    # Detecta se o edge morreu (win rate caiu abaixo de 45% no regime atual)
    edge_death = []
    for symbol, regimes in regime_stats.items():
        # Verifica tendência recente (simulado - seria melhor com dados temporais)
        pass

    return {
        "regime_switches": switches[:10],
        "has_switch": len(switches) > 0,
        "regime_performance": regime_stats,
        "recommendation": "Consider regime-specific filtering" if len(switches) > 3 else "Regime impact is manageable"
    }


def _calculate_walk_forward_validation(returns_by_period: list[list[float]], n_folds: int = 4) -> dict:
    """
    Walk-forward validation para detectar overfitting.
    Treina em períodos anteriores, testa em períodos futuros.
    """
    if len(returns_by_period) < n_folds * 2:
        return {"validated": False, "reason": "insufficient_periods", "overfitting_risk": "UNKNOWN"}

    fold_size = len(returns_by_period) // n_folds
    oos_returns = []  # Out-of-sample returns
    is_returns = []   # In-sample returns

    for i in range(n_folds - 1):
        train_start = i * fold_size
        train_end = (i + 1) * fold_size
        test_start = train_end
        test_end = min(test_start + fold_size, len(returns_by_period))

        if test_start >= len(returns_by_period):
            break

        train_returns = [r for period in returns_by_period[train_start:train_end] for r in period]
        test_returns = [r for period in returns_by_period[test_start:test_end] for r in period]

        if train_returns and test_returns:
            train_wr = len([r for r in train_returns if r > 0]) / len(train_returns)
            test_wr = len([r for r in test_returns if r > 0]) / len(test_returns)
            oos_returns.extend(test_returns)
            is_returns.extend(train_returns)

            # Se test_wr for muito menor que train_wr, overfitting
            if test_wr < train_wr - 0.1:
                pass  # Marcaria como overfitting

    if not oos_returns:
        return {"validated": False, "reason": "no_oos_data", "overfitting_risk": "UNKNOWN"}

    oos_wr = len([r for r in oos_returns if r > 0]) / len(oos_returns) if oos_returns else 0
    is_wr = len([r for r in is_returns if r > 0]) / len(is_returns) if is_returns else 0
    degradation = is_wr - oos_wr

    if degradation > 0.1:
        overfitting_risk = "HIGH"
        recommendation = "Strategy likely overfitted - reduce complexity"
    elif degradation > 0.05:
        overfitting_risk = "MEDIUM"
        recommendation = "Some overfitting detected - simplify or add regularization"
    elif degradation < -0.05:
        overfitting_risk = "NEGATIVE"  # Estratégia melhorou fora da amostra
        recommendation = "Strategy may have positive drift - continue monitoring"
    else:
        overfitting_risk = "LOW"
        recommendation = "Walk-forward validation passed - strategy is robust"

    return {
        "validated": True,
        "overfitting_risk": overfitting_risk,
        "recommendation": recommendation,
        "in_sample_win_rate": round(is_wr * 100, 1),
        "out_of_sample_win_rate": round(oos_wr * 100, 1),
        "degradation_pp": round(degradation * 100, 1),
        "n_folds": n_folds,
        "oos_samples": len(oos_returns)
    }


def _calculate_bootstrap_confidence(returns: list[float], n_bootstrap: int = 5000, confidence: float = 0.95) -> dict:
    """
    Bootstrap para intervalo de confiança do Sharpe e Expectancy.
    """
    if len(returns) < 10:
        return {"reliable": False, "samples": len(returns)}

    bootstrap_sharpes = []
    bootstrap_expectancy = []

    for _ in range(n_bootstrap):
        sample = [random.choice(returns) for _ in range(len(returns))]

        # Sharpe do bootstrap
        mean_sample = sum(sample) / len(sample)
        var_sample = sum((r - mean_sample) ** 2 for r in sample) / len(sample)
        std_sample = math.sqrt(var_sample) if var_sample > 0 else 0.0001
        sharpe_sample = mean_sample / std_sample if std_sample > 0 else 0
        bootstrap_sharpes.append(sharpe_sample)

        # Expectancy do bootstrap
        avg_win_sample = sum(r for r in sample if r > 0) / max(1, len([r for r in sample if r > 0]))
        avg_loss_sample = abs(sum(r for r in sample if r < 0)) / max(1, len([r for r in sample if r < 0]))
        win_rate_sample = len([r for r in sample if r > 0]) / len(sample)
        expectancy_sample = (win_rate_sample * avg_win_sample) - ((1 - win_rate_sample) * avg_loss_sample)
        bootstrap_expectancy.append(expectancy_sample)

    bootstrap_sharpes.sort()
    bootstrap_expectancy.sort()

    alpha = 1 - confidence
    lower_idx = int(n_bootstrap * alpha / 2)
    upper_idx = int(n_bootstrap * (1 - alpha / 2))

    observed_sharpe = _calculate_sharpe_ratio(returns)["sharpe"]
    observed_expectancy = _calculate_expectancy(returns)["expectancy_usdt"]

    return {
        "reliable": len(returns) >= 30,
        "samples": len(returns),
        "sharpe": {
            "observed": observed_sharpe,
            "lower_bound": round(bootstrap_sharpes[lower_idx], 4),
            "upper_bound": round(bootstrap_sharpes[upper_idx], 4),
            "margin_error": round((bootstrap_sharpes[upper_idx] - bootstrap_sharpes[lower_idx]) / 2, 4)
        },
        "expectancy_usdt": {
            "observed": round(observed_expectancy, 4),
            "lower_bound": round(bootstrap_expectancy[lower_idx], 4),
            "upper_bound": round(bootstrap_expectancy[upper_idx], 4)
        }
    }


def _calculate_pnl_attribution(returns_by_symbol: dict, returns_by_hour: dict, returns_by_regime: dict) -> dict:
    """
    Attribution de PnL: qual símbolo/horário/regime contribuiu mais.
    """
    attribution = {
        "by_symbol": [],
        "by_hour": [],
        "by_regime": []
    }

    # Por símbolo
    for symbol, returns in returns_by_symbol.items():
        if returns:
            total_pnl = sum(returns)
            attribution["by_symbol"].append({
                "symbol": symbol,
                "total_pnl_usdt": round(total_pnl, 4),
                "trade_count": len(returns),
                "contribution_pct": 0  # Será normalizado depois
            })

    # Por horário
    for hour, returns in returns_by_hour.items():
        if returns:
            total_pnl = sum(returns)
            attribution["by_hour"].append({
                "hour": hour,
                "total_pnl_usdt": round(total_pnl, 4),
                "trade_count": len(returns)
            })

    # Por regime
    for regime, returns in returns_by_regime.items():
        if returns:
            total_pnl = sum(returns)
            attribution["by_regime"].append({
                "regime": regime,
                "total_pnl_usdt": round(total_pnl, 4),
                "trade_count": len(returns)
            })

    # Normaliza contribuições
    total_pnl = sum(item["total_pnl_usdt"] for item in attribution["by_symbol"])
    for item in attribution["by_symbol"]:
        item["contribution_pct"] = round(item["total_pnl_usdt"] / total_pnl * 100, 1) if total_pnl != 0 else 0

    # Ordena por contribuição
    attribution["by_symbol"].sort(key=lambda x: x["contribution_pct"], reverse=True)
    attribution["by_hour"].sort(key=lambda x: x["total_pnl_usdt"], reverse=True)
    attribution["by_regime"].sort(key=lambda x: x["total_pnl_usdt"], reverse=True)

    # Identifica concentração (risco)
    top3_contribution = sum(item["contribution_pct"] for item in attribution["by_symbol"][:3])
    concentration_risk = "HIGH" if top3_contribution > 70 else "MEDIUM" if top3_contribution > 50 else "LOW"

    attribution["concentration_risk"] = concentration_risk
    attribution["top3_contribution_pct"] = round(top3_contribution, 1)

    return attribution


# ========== FUNÇÕES EXISTENTES (MANTIDAS) ==========

async def compute_edge_evolution(days: int = 30) -> list[EdgeEvolution]:
    """
    Divide o período em duas metades e compara win rate / PnL médio.
    Detecta se o edge está melhorando ou deteriorando.
    """
    from core.knowledge_base import DB_PATH

    since = time.time() - days * 86400
    mid = since + (days * 86400) / 2
    evolutions = []

    async with connect(DB_PATH) as db:
        db.row_factory = Row
        for sym in SYMBOLS_SHORT:
            for side in ["LONG", "SHORT"]:
                early = await (await db.execute(
                    """SELECT COUNT(*) as n, SUM(win) as w, AVG(pnl_pct) as ap
                       FROM trade_outcomes
                       WHERE symbol=? AND side=? AND timestamp BETWEEN ? AND ?""",
                    (sym, side, since, mid)
                )).fetchone()
                late = await (await db.execute(
                    """SELECT COUNT(*) as n, SUM(win) as w, AVG(pnl_pct) as ap
                       FROM trade_outcomes
                       WHERE symbol=? AND side=? AND timestamp > ?""",
                    (sym, side, mid)
                )).fetchone()

                n_early = early["n"] or 0
                n_late = late["n"] or 0
                if n_early < 3 and n_late < 3:
                    continue

                wr_early = (early["w"] or 0) / n_early if n_early > 0 else 0
                wr_late = (late["w"] or 0) / n_late if n_late > 0 else 0
                ap_early = early["ap"] or 0
                ap_late = late["ap"] or 0
                delta_wr = wr_late - wr_early

                if delta_wr >= 0.05:
                    trend = "IMPROVING"
                elif delta_wr <= -0.05:
                    trend = "DETERIORATING"
                else:
                    trend = "STABLE"

                evolutions.append(EdgeEvolution(
                    symbol=sym,
                    side=side,
                    period_label=f"{days}d",
                    win_rate_early=round(wr_early * 100, 1),
                    win_rate_late=round(wr_late * 100, 1),
                    delta_wr=round(delta_wr * 100, 1),
                    avg_pnl_early=round(ap_early, 4),
                    avg_pnl_late=round(ap_late, 4),
                    delta_pnl=round(ap_late - ap_early, 4),
                    trades_early=n_early,
                    trades_late=n_late,
                    trend=trend,
                ))

    return evolutions


async def _get_regime_performance(returns_by_symbol_regime: dict) -> dict:
    """Coleta performance por regime para detecção de regime-switching."""
    # Esta função seria implementada com dados reais do banco
    # Por enquanto retorna estrutura vazia que será preenchida
    return {}


async def build_strategic_report(days: int = 30) -> StrategicReport:
    """Gera relatório completo: stats globais + evolução de edge por símbolo."""
    from core.knowledge_base import DB_PATH

    since = time.time() - days * 86400
    all_stats = await kb.get_all_symbols_stats(days)
    evolutions = await compute_edge_evolution(days)

    async with connect(DB_PATH) as db:
        db.row_factory = Row
        totals = await (await db.execute(
            """SELECT COUNT(*) as n, SUM(win) as w, AVG(pnl_pct) as ap
               FROM trade_outcomes WHERE timestamp >= ?""",
            (since,)
        )).fetchone()

        # Busca todos os retornos para métricas avançadas
        all_returns = await (await db.execute(
            """SELECT pnl_pct, symbol, side, btc_regime, timestamp
               FROM trade_outcomes WHERE timestamp >= ?""",
            (since,)
        )).fetchall()

    total_trades = totals["n"] or 0
    global_wr = (totals["w"] or 0) / total_trades * 100 if total_trades > 0 else 0

    # Converte retornos para lista de floats
    returns_list = [float(r["pnl_pct"] or 0) for r in all_returns]

    # ========== NOVAS MÉTRICAS PARA NÍVEL WAR ==========

    # 1. Métricas ajustadas por risco
    sharpe = _calculate_sharpe_ratio(returns_list)
    sortino = _calculate_sortino_ratio(returns_list)
    max_dd = _calculate_max_drawdown(returns_list)
    calmar = _calculate_calmar_ratio(returns_list, max_dd["max_drawdown_pct"])
    profit_factor = _calculate_profit_factor(returns_list)
    expectancy = _calculate_expectancy(returns_list)

    risk_metrics = {
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown": max_dd,
        "calmar": calmar,
        "profit_factor": profit_factor,
        "expectancy": expectancy
    }

    # 2. Testes estatísticos
    wr_confidence = _calculate_win_rate_confidence(returns_list)
    t_test = _calculate_t_test_vs_random(returns_list)

    statistical_tests = {
        "win_rate_confidence": wr_confidence,
        "t_test_vs_random": t_test,
        "is_edge_real": wr_confidence["verdict"] in ["POSITIVE_EDGE_CONFIRMED", "NEGATIVE_EDGE_CONFIRMED"]
    }

    # 3. Bootstrap confidence
    bootstrap = _calculate_bootstrap_confidence(returns_list)

    # 4. Regime performance (simplificado - expandir com dados reais)
    regime_performance = {
        "analysis": "Regime performance analysis requires historical regime data",
        "recommendation": "Monitor BULL vs BEAR performance separately"
    }

    # 5. Walk-forward validation (requer dados por período)
    # Por simplicidade, retorna status pendente
    walk_forward = {
        "validated": False,
        "reason": "Requires time-series data by period",
        "overfitting_risk": "PENDING"
    }

    # 6. PnL attribution (simplificado)
    pnl_attribution = {
        "note": "Full attribution requires symbol/hour/regime breakdown",
        "total_pnl_usdt": round(sum(returns_list), 4),
        "trade_count": len(returns_list)
    }

    # Rank símbolos por win rate
    ranked = []
    for stat in all_stats:
        for side, data in stat.get("sides", {}).items():
            if data["trades"] >= 3:
                ranked.append({
                    "symbol": stat["symbol"],
                    "side": side,
                    "win_rate": data["win_rate"],
                    "avg_pnl": data["avg_pnl"],
                    "trades": data["trades"],
                })
    ranked.sort(key=lambda x: x["win_rate"], reverse=True)

    top = ranked[:5]
    worst = ranked[-5:] if len(ranked) >= 5 else []

    # Mudanças estruturais detectadas
    structural = []
    deteriorating = [e for e in evolutions if e.trend == "DETERIORATING" and abs(e.delta_wr) >= 8]
    improving = [e for e in evolutions if e.trend == "IMPROVING" and e.delta_wr >= 8]

    for e in deteriorating:
        structural.append(
            f"⚠️ Edge deteriorando: {e.symbol} {e.side} — WR caiu {abs(e.delta_wr):.0f}pp "
            f"({e.win_rate_early:.0f}% → {e.win_rate_late:.0f}%) nos últimos {days}d"
        )
    for e in improving:
        structural.append(
            f"✅ Edge melhorando: {e.symbol} {e.side} — WR subiu {e.delta_wr:.0f}pp "
            f"({e.win_rate_early:.0f}% → {e.win_rate_late:.0f}%) nos últimos {days}d"
        )

    # Adiciona recomendações baseadas em métricas de risco
    if sharpe["annualized_sharpe"] < 1.0 and len(returns_list) > 50:
        structural.append(f"⚠️ Sharpe Ratio baixo ({sharpe['annualized_sharpe']:.2f}) — estratégia pode não compensar risco")

    if max_dd["max_drawdown_pct"] > 10:
        structural.append(f"🔻 Drawdown elevado ({max_dd['max_drawdown_pct']:.1f}%) — revisar stop loss")

    if wr_confidence["verdict"] == "INCONCLUSIVE_MAYBE_LUCK" and len(returns_list) > 100:
        structural.append(f"⚠️ Edge pode ser sorte — intervalo de confiança contém 50%")

    if t_test["significant_95"] and t_test["p_value"] < 0.01:
        structural.append(f"📊 Edge estatisticamente significativo (p={t_test['p_value']:.5f})")

    # Edge migration
    if deteriorating and improving:
        from_syms = ", ".join(f"{e.symbol} {e.side}" for e in deteriorating[:2])
        to_syms = ", ".join(f"{e.symbol} {e.side}" for e in improving[:2])
        structural.append(f"🔄 Migração de edge detectada: [{from_syms}] → [{to_syms}]")

    edge_changes = {
        e.symbol + "_" + e.side: {
            "wr_early": e.win_rate_early,
            "wr_late": e.win_rate_late,
            "delta": e.delta_wr,
            "trend": e.trend,
        }
        for e in evolutions
    }

    return StrategicReport(
        period_days=days,
        generated_at=time.time(),
        total_trades=total_trades,
        global_win_rate=round(global_wr, 1),
        top_performers=top,
        worst_performers=worst,
        edge_migrations=evolutions,
        structural_changes=structural,
        raw_stats={s["symbol"]: s for s in all_stats},
        risk_metrics=risk_metrics,
        statistical_tests=statistical_tests,
        regime_performance=regime_performance,
        walk_forward_validation=walk_forward,
        bootstrap_confidence=bootstrap,
        pnl_attribution=pnl_attribution
    )


def report_to_dict(report: StrategicReport) -> dict:
    return {
        "period_days": report.period_days,
        "generated_at": report.generated_at,
        "total_trades": report.total_trades,
        "global_win_rate": report.global_win_rate,
        "top_performers": report.top_performers,
        "worst_performers": report.worst_performers,
        "structural_changes": report.structural_changes,
        "edge_migrations": [
            {
                "symbol": e.symbol,
                "side": e.side,
                "wr_early": e.win_rate_early,
                "wr_late": e.win_rate_late,
                "delta_wr": e.delta_wr,
                "trend": e.trend,
                "trades_early": e.trades_early,
                "trades_late": e.trades_late,
            }
            for e in report.edge_migrations
        ],
        "raw_stats": report.raw_stats,
        # NOVOS CAMPOS
        "risk_metrics": report.risk_metrics,
        "statistical_tests": report.statistical_tests,
        "regime_performance": report.regime_performance,
        "walk_forward_validation": report.walk_forward_validation,
        "bootstrap_confidence": report.bootstrap_confidence,
        "pnl_attribution": report.pnl_attribution
    }


async def run_strategic_loop(interval_hours: int = 6):
    """Roda análise estratégica a cada N horas e salva na KB."""
    await kb.init_db()
    log.info(f"Strategic loop iniciado (interval={interval_hours}h)")
    while True:
        try:
            for days in [7, 30]:
                report = await build_strategic_report(days)
                if report.total_trades > 0:
                    # Recomendações expandidas com base nas novas métricas
                    recommendations = []

                    # Recomendações existentes
                    for e in report.edge_migrations:
                        if e.trend == "DETERIORATING" and abs(e.delta_wr) >= 8:
                            recommendations.append(f"Reduzir exposição em {e.symbol} {e.side} (WR caindo {abs(e.delta_wr):.0f}pp)")

                    # Novas recomendações baseadas em risco
                    if report.risk_metrics.get("sharpe", {}).get("annualized_sharpe", 0) < 1.0:
                        recommendations.append(f"Sharpe Ratio baixo ({report.risk_metrics['sharpe']['annualized_sharpe']:.2f}) — revisar strategy risk/reward")

                    if report.risk_metrics.get("max_drawdown", {}).get("max_drawdown_pct", 0) > 10:
                        recommendations.append(f"Drawdown elevado ({report.risk_metrics['max_drawdown']['max_drawdown_pct']:.1f}%) — tighten stops")

                    if report.statistical_tests.get("win_rate_confidence", {}).get("verdict") == "INCONCLUSIVE_MAYBE_LUCK":
                        recommendations.append("Edge may be luck — gather more samples before increasing size")

                    await kb.save_strategic_insight(
                        period_days=days,
                        analysis_text="\n".join(report.structural_changes) or "Sem mudanças estruturais detectadas.",
                        edge_changes={
                            e.symbol + "_" + e.side: {
                                "trend": e.trend,
                                "delta_wr": e.delta_wr,
                            }
                            for e in report.edge_migrations
                        },
                        recommendations=recommendations if recommendations else ["Continuar monitoramento — edge estável"],
                    )
                    log.info(f"Strategic report ({days}d) salvo — {report.total_trades} trades analisados | Sharpe: {report.risk_metrics.get('sharpe', {}).get('annualized_sharpe', 0):.2f}")
        except Exception as e:
            log.error(f"Strategic loop error: {e}")

        await asyncio.sleep(interval_hours * 3600)
