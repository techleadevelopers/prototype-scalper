"""
Camada IA Raciocinadora — usa Claude para analisar dados quant e gerar insights.
Recebe fatos da Camada 1 (Quant) e produz relatórios estruturados.
"""
from __future__ import annotations

import asyncio
import os
import time
import json
import logging
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger("ai_analyst")

try:
    import anthropic
    _HAS_ANTHROPIC = True
except ImportError:
    _HAS_ANTHROPIC = False


def _get_client() -> Optional["anthropic.AsyncAnthropic"]:
    if not _HAS_ANTHROPIC:
        return None
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None
    return anthropic.AsyncAnthropic(api_key=key)


def _has_ai() -> bool:
    return _HAS_ANTHROPIC and bool(os.environ.get("ANTHROPIC_API_KEY", ""))


@dataclass
class AIAnalysis:
    analysis_type: str
    generated_at: float
    model: str
    summary: str
    full_text: str
    data_snapshot: dict


def _build_weekly_prompt(stats: list[dict], evolutions: list[dict], patterns: list[dict]) -> str:
    stats_text = []
    for s in stats:
        sym = s.get("symbol", "?")
        sides = s.get("sides", {})
        for side, d in sides.items():
            if d.get("trades", 0) > 0:
                stats_text.append(
                    f"  {sym} {side}: WR={d['win_rate']}% | avg_pnl={d['avg_pnl']:+.4f} | trades={d['trades']}"
                )

    evol_text = []
    for e in evolutions:
        trend = e.get("trend", "?")
        delta = e.get("delta_wr", 0)
        sym = e.get("symbol", "?")
        side = e.get("side", "?")
        evol_text.append(f"  {sym} {side}: {e.get('wr_early', 0):.0f}% → {e.get('wr_late', 0):.0f}% ({delta:+.0f}pp) [{trend}]")

    pat_text = []
    for p in patterns[:10]:
        pat_text.append(
            f"  {p['name']} @ {p['symbol']}: occ={p['occurrences']} | WR={p['win_rate']:.0%} | avg_ret={p['avg_return']:+.4f}"
        )

    return f"""Você é um Head of Quant analisando um bot de trading de futuros na BingX.

ATIVOS MONITORADOS: BTC, ETH, SOL, VVV, TRUMP, MELANIA, BEAT, NEAR, HYPE, POL

ESTATÍSTICAS DO PERÍODO (últimos 30 dias):
{chr(10).join(stats_text) if stats_text else "  Sem trades suficientes para análise."}

EVOLUÇÃO DE EDGE (primeira metade vs segunda metade do período):
{chr(10).join(evol_text) if evol_text else "  Sem dados suficientes."}

PADRÕES MAIS FREQUENTES NA KNOWLEDGE BASE:
{chr(10).join(pat_text) if pat_text else "  Nenhum padrão acumulado ainda."}

Com base nesses dados, produza uma ANÁLISE SEMANAL estruturada com:
1. Diagnóstico geral do sistema (2-3 frases)
2. Ativos com edge melhorando (se houver)
3. Ativos com edge deteriorando (se houver) e possíveis causas
4. Padrões de mercado mais confiáveis identificados
5. Recomendações específicas de ajuste (reduzir/aumentar exposição por símbolo/lado)
6. Uma hipótese original não óbvia que os dados sugerem

Seja direto, quantitativo e objetivo. Use os números disponíveis.
Se não há dados suficientes, diga claramente e forneça análise do que seria necessário observar."""


def _build_tactical_prompt(alerts: list[dict], snapshots: dict, observations: list[dict]) -> str:
    alert_text = []
    for a in alerts[:10]:
        alert_text.append(
            f"  [{a.get('symbol','?').replace('-USDT','')}] {a.get('alert_type','?')} "
            f"| conf={a.get('confidence',0):.0%} | occ={a.get('similar_occurrences',0)} "
            f"| hist_wr={a.get('win_rate_past',0):.0%} | hist_ret={a.get('avg_return_past',0):+.4f}"
        )

    snap_text = []
    for sym, snap in list(snapshots.items())[:6]:
        short = sym.replace("-USDT", "")
        snap_text.append(
            f"  {short}: price={snap.get('price',0):.4f} | "
            f"OI={snap.get('oi_change_pct',0):+.1f}% | "
            f"vol={snap.get('volume_ratio',1):.1f}x | "
            f"fund={snap.get('funding_rate',0):+.4f} | "
            f"RSI={snap.get('rsi',50):.0f} | "
            f"regime={snap.get('btc_regime','?')}"
        )

    obs_text = [f"  [{o.get('symbol','?').replace('-USDT','')}] {o.get('text','')[:120]}" for o in observations[:5]]

    return f"""Você é um analista quant de alta frequência monitorando mercados de futuros cripto em tempo real.

ESTADO ATUAL DO MERCADO:
{chr(10).join(snap_text) if snap_text else "  Sem snapshots disponíveis."}

ALERTAS TÁTICOS RECENTES (últimos 5 min):
{chr(10).join(alert_text) if alert_text else "  Nenhum alerta ativo."}

OBSERVAÇÕES RECENTES DA KNOWLEDGE BASE:
{chr(10).join(obs_text) if obs_text else "  Sem observações recentes."}

Produza uma ANÁLISE TÁTICA em tempo real com:
1. Diagnóstico do momento atual (qual ativo está em movimento, qual dormindo)
2. Setup mais interessante agora — símbolo, lado (LONG/SHORT) e razão
3. Risco detectado (funding excessivo, spread largo, volume baixo, etc.)
4. Correlações ou lead-lag visíveis entre os ativos
5. Uma observação que um humano não perceberia olhando o gráfico manualmente

Seja específico, use os números. Máximo 250 palavras."""


def _build_hypothesis_prompt(patterns: list[dict], observations: list[dict], stats: list[dict]) -> str:
    pat_text = "\n".join(
        f"  {p['name']} @ {p['symbol']}: occ={p['occurrences']}, WR={p['win_rate']:.0%}, avg={p['avg_return']:+.4f}"
        for p in patterns[:15]
    )
    obs_text = "\n".join(
        f"  [{o['symbol'].replace('-USDT','')}] [{o['category']}] {o['text'][:150]}"
        for o in observations[:10]
    )

    return f"""Você é um pesquisador quant gerando hipóteses de edge para um bot de trading.

PADRÕES ACUMULADOS NA KNOWLEDGE BASE:
{pat_text if pat_text.strip() else "  Sem padrões suficientes ainda."}

OBSERVAÇÕES RECENTES:
{obs_text if obs_text.strip() else "  Sem observações."}

Com base nesses dados, gere 3 HIPÓTESES ORIGINAIS no formato:

HIPÓTESE 1:
Observação: [o que os dados mostram]
Mecanismo proposto: [por que isso acontece]
Setup derivado: [como o bot poderia explorar isso]
Testável por: [métrica que confirmaria ou refutaria]

Seja específico e use os dados disponíveis. Hipóteses vagas não têm valor."""


async def run_weekly_analysis(stats: list[dict], evolutions: list[dict], patterns: list[dict]) -> AIAnalysis:
    ts = time.time()
    prompt = _build_weekly_prompt(stats, evolutions, patterns)

    if not _has_ai():
        text = _fallback_weekly(stats, evolutions, patterns)
        return AIAnalysis("WEEKLY", ts, "fallback", text[:200], text, {})

    client = _get_client()
    try:
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        full_text = msg.content[0].text
        summary = full_text[:200]
        return AIAnalysis("WEEKLY", ts, "claude-haiku-4-5", summary, full_text, {
            "stats_count": len(stats),
            "evolutions_count": len(evolutions),
            "patterns_count": len(patterns),
        })
    except Exception as e:
        log.error(f"AI weekly analysis error: {e}")
        text = _fallback_weekly(stats, evolutions, patterns)
        return AIAnalysis("WEEKLY", ts, "fallback", text[:200], text, {})


async def run_tactical_analysis(alerts: list[dict], snapshots: dict, observations: list[dict]) -> AIAnalysis:
    ts = time.time()
    prompt = _build_tactical_prompt(alerts, snapshots, observations)

    if not _has_ai():
        text = _fallback_tactical(alerts, snapshots)
        return AIAnalysis("TACTICAL", ts, "fallback", text[:200], text, {})

    client = _get_client()
    try:
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}],
        )
        full_text = msg.content[0].text
        return AIAnalysis("TACTICAL", ts, "claude-haiku-4-5", full_text[:200], full_text, {
            "alerts": len(alerts),
            "snapshots": len(snapshots),
        })
    except Exception as e:
        log.error(f"AI tactical analysis error: {e}")
        text = _fallback_tactical(alerts, snapshots)
        return AIAnalysis("TACTICAL", ts, "fallback", text[:200], text, {})


async def run_hypothesis_generation(patterns: list[dict], observations: list[dict], stats: list[dict]) -> AIAnalysis:
    ts = time.time()
    prompt = _build_hypothesis_prompt(patterns, observations, stats)

    if not _has_ai():
        text = _fallback_hypothesis(patterns)
        return AIAnalysis("HYPOTHESIS", ts, "fallback", text[:200], text, {})

    client = _get_client()
    try:
        msg = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1200,
            messages=[{"role": "user", "content": prompt}],
        )
        full_text = msg.content[0].text
        return AIAnalysis("HYPOTHESIS", ts, "claude-haiku-4-5", full_text[:200], full_text, {})
    except Exception as e:
        log.error(f"AI hypothesis error: {e}")
        text = _fallback_hypothesis(patterns)
        return AIAnalysis("HYPOTHESIS", ts, "fallback", text[:200], text, {})


def _fallback_weekly(stats: list[dict], evolutions: list[dict], patterns: list[dict]) -> str:
    lines = ["=== ANÁLISE SEMANAL (modo sem IA) ===\n"]
    if not stats or not any(s.get("sides") for s in stats):
        lines.append("Sem trades suficientes para análise. Acumule pelo menos 10 trades por símbolo.")
        lines.append("\nPara ativar análise por IA: configure ANTHROPIC_API_KEY nas variáveis de ambiente.")
        return "\n".join(lines)

    for s in stats:
        sym = s.get("symbol", "?")
        sides = s.get("sides", {})
        for side, d in sides.items():
            if d.get("trades", 0) >= 3:
                lines.append(f"{sym} {side}: WR={d['win_rate']}% | avg={d['avg_pnl']:+.4f} | n={d['trades']}")

    det = [e for e in evolutions if e.get("trend") == "DETERIORATING"]
    imp = [e for e in evolutions if e.get("trend") == "IMPROVING"]

    if det:
        lines.append("\n⚠️ Deteriorando:")
        for e in det:
            lines.append(f"  {e['symbol']} {e['side']}: {e['wr_early']:.0f}% → {e['wr_late']:.0f}%")
    if imp:
        lines.append("\n✅ Melhorando:")
        for e in imp:
            lines.append(f"  {e['symbol']} {e['side']}: {e['wr_early']:.0f}% → {e['wr_late']:.0f}%")

    lines.append("\nPara análise narrativa completa: configure ANTHROPIC_API_KEY.")
    return "\n".join(lines)


def _fallback_tactical(alerts: list[dict], snapshots: dict) -> str:
    lines = ["=== ANÁLISE TÁTICA (modo sem IA) ===\n"]
    if alerts:
        lines.append(f"Alertas ativos: {len(alerts)}")
        for a in alerts[:5]:
            sym = a.get("symbol", "?").replace("-USDT", "")
            lines.append(f"  {sym}: {a.get('alert_type','?')} | conf={a.get('confidence',0):.0%}")
    else:
        lines.append("Nenhum alerta tático no momento.")

    lines.append("\nPara análise narrativa em tempo real: configure ANTHROPIC_API_KEY.")
    return "\n".join(lines)


def _fallback_hypothesis(patterns: list[dict]) -> str:
    lines = ["=== GERAÇÃO DE HIPÓTESES (modo sem IA) ===\n"]
    if patterns:
        top = patterns[:3]
        for i, p in enumerate(top, 1):
            lines.append(f"HIPÓTESE {i}:")
            lines.append(f"  Padrão {p['name']} em {p['symbol']} ocorreu {p['occurrences']}× "
                         f"com WR={p['win_rate']:.0%} e retorno médio {p['avg_return']:+.4f}")
            lines.append(f"  Sugestão: investigar condições de mercado associadas a esse padrão.\n")
    else:
        lines.append("Acumule mais trades e padrões antes de gerar hipóteses.")
    lines.append("Para hipóteses geradas por IA: configure ANTHROPIC_API_KEY.")
    return "\n".join(lines)
