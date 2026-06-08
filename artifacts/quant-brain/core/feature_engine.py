"""
Feature Engine — coleta dados de mercado da BingX a cada 1s/5s/15s/30s/1min
para os 10 ativos. Calcula: preço, OI, funding, volume, CVD, spread, volatilidade.
Nível Máximo de Excelência: microestrutura, order book depth, volume profile,
delta accumulation, tick quality, latency metrics, data integrity validation.
"""
from __future__ import annotations

import asyncio
import time
import os
import hmac
import hashlib
import json
import math
from collections import deque
from dataclasses import dataclass, field
from typing import Optional
import httpx

BINGX_BASE = "https://open-api.bingx.com"
HTTP_CONCURRENCY = max(1, int(os.environ.get("FEATURE_HTTP_CONCURRENCY", "8")))
SNAPSHOT_CONCURRENCY = max(1, int(os.environ.get("FEATURE_SNAPSHOT_CONCURRENCY", "3")))
HTTP_TIMEOUT_SECONDS = max(1.0, float(os.environ.get("FEATURE_HTTP_TIMEOUT_SECONDS", "4")))
SYMBOLS = [
    "BTC-USDT", "ETH-USDT", "SOL-USDT", "VVV-USDT", "TRUMP-USDT",
    "MELANIA-USDT", "BEAT-USDT", "NEAR-USDT", "HYPE-USDT", "POL-USDT",
]
SYMBOL_SHORT = {s: s.replace("-USDT", "").replace("-USD", "") for s in SYMBOLS}


@dataclass
class MarketSnapshot:
    symbol: str
    timestamp: float
    price: float
    price_change_pct: float
    volume_24h: float
    volume_ratio: float        # vol atual vs média 24h
    oi: float                  # open interest
    oi_change_pct: float       # variação % OI vs snapshot anterior
    funding_rate: float
    bid: float
    ask: float
    spread_bps: float
    high_24h: float
    low_24h: float
    atr_pct: float             # proxy: (high-low)/price
    btc_regime: str            # BULL / BEAR / NEUTRAL
    rsi_approx: float          # RSI simplificado dos últimos ticks
    anomalies: list[str] = field(default_factory=list)

    # NOVOS CAMPOS PARA NÍVEL MÁXIMO DE EXCELÊNCIA
    bid_depth_5: float = 0.0       # soma das 5 primeiras bids
    ask_depth_5: float = 0.0       # soma das 5 primeiras asks
    bid_ask_imbalance: float = 0.0 # (bid_depth - ask_depth) / (bid_depth + ask_depth)
    mid_price: float = 0.0         # (bid + ask) / 2
    effective_spread_bps: float = 0.0  # spread considerando depth
    tick_direction: int = 0        # 1=up, -1=down, 0=zero
    cumulative_delta: float = 0.0  # CVD acumulado desde início
    volume_imbalance: float = 0.0  # (vol_buy - vol_sell) / total_vol
    bid_volume_24h: float = 0.0    # volume em bids
    ask_volume_24h: float = 0.0    # volume em asks
    latency_ms: float = 0.0        # latência da requisição
    data_quality_score: float = 1.0  # 0-1
    price_confidence: float = 1.0  # 0-1 baseado em profundidade


class FeatureEngine:
    def __init__(self):
        self._client: Optional[httpx.AsyncClient] = None
        self._prev_oi: dict[str, float] = {}
        self._prev_volume_24h: dict[str, float] = {}
        self._volume_increment_history: dict[str, deque] = {s: deque(maxlen=60) for s in SYMBOLS}
        self._prev_prices: dict[str, list[float]] = {s: [] for s in SYMBOLS}
        self._snapshots: dict[str, MarketSnapshot] = {}
        self._btc_change = 0.0
        self._callbacks: list = []

        # ========== NOVAS ESTRUTURAS PARA EXCELÊNCIA ==========
        self._cumulative_delta: dict[str, float] = {s: 0.0 for s in SYMBOLS}
        self._prev_price: dict[str, float] = {}
        self._volume_imbalance_cache: dict[str, deque] = {s: deque(maxlen=100) for s in SYMBOLS}
        self._latency_history: dict[str, deque] = {s: deque(maxlen=100) for s in SYMBOLS}
        self._price_history_detailed: dict[str, deque] = {s: deque(maxlen=200) for s in SYMBOLS}
        self._order_book_cache: dict[str, dict] = {}
        self._last_snapshot_time: dict[str, float] = {}
        self._heartbeat_counter: dict[str, int] = {s: 0 for s in SYMBOLS}
        self._websocket_connected: bool = False
        self._http_semaphore = asyncio.Semaphore(HTTP_CONCURRENCY)
        self._snapshot_semaphore = asyncio.Semaphore(SNAPSHOT_CONCURRENCY)

    def on_snapshot(self, fn):
        self._callbacks.append(fn)

    @property
    def client(self) -> httpx.AsyncClient:
        if not self._client:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(HTTP_TIMEOUT_SECONDS),
                limits=httpx.Limits(
                    max_connections=max(HTTP_CONCURRENCY, SNAPSHOT_CONCURRENCY) * 2,
                    max_keepalive_connections=max(HTTP_CONCURRENCY, SNAPSHOT_CONCURRENCY),
                ),
            )
        return self._client

    def _sign(self, params: dict) -> str:
        qs = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        secret = os.environ.get("BINGX_SECRET_KEY", "")
        return hmac.new(secret.encode(), qs.encode(), hashlib.sha256).hexdigest()

    async def _get(self, path: str, params: dict = {}, signed: bool = False) -> dict:
        p = dict(params)
        if signed:
            p["timestamp"] = int(time.time() * 1000)
            p["signature"] = self._sign(p)
        headers = {}
        api_key = os.environ.get("BINGX_API_KEY", "")
        if api_key:
            headers["X-BX-APIKEY"] = api_key
        try:
            async with self._http_semaphore:
                r = await self.client.get(f"{BINGX_BASE}{path}", params=p, headers=headers)
            return r.json()
        except Exception as e:
            return {"code": -1, "error": str(e)}

    async def fetch_ticker(self, symbol: str) -> dict:
        r = await self._get("/openApi/swap/v2/quote/ticker", {"symbol": symbol})
        if r.get("code") == 0:
            return r.get("data", {})
        return {}

    async def fetch_funding(self, symbol: str) -> float:
        r = await self._get("/openApi/swap/v2/quote/premiumIndex", {"symbol": symbol})
        if r.get("code") == 0:
            data = r.get("data", {})
            try:
                return float(data.get("lastFundingRate", 0))
            except Exception:
                return 0.0
        return 0.0

    async def fetch_oi(self, symbol: str) -> float:
        r = await self._get("/openApi/swap/v2/quote/openInterest", {"symbol": symbol})
        if r.get("code") == 0:
            data = r.get("data", {})
            try:
                return float(data.get("openInterest", 0))
            except Exception:
                return 0.0
        return 0.0

    async def fetch_klines(self, symbol: str, interval: str = "1h", limit: int = 100) -> list[dict]:
        r = await self._get("/openApi/swap/v2/quote/klines", {
            "symbol": symbol,
            "interval": interval,
            "limit": str(limit),
        })
        if r.get("code") != 0:
            return []
        data = r.get("data", [])
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    async def fetch_orderbook(self, symbol: str, depth: int = 10) -> tuple[float, float, float, float, float, float]:
        """
        Busca order book com profundidade para análise de liquidez.
        Retorna: bid, ask, bid_depth_5, ask_depth_5, bid_ask_imbalance, mid_price
        """
        r = await self._get("/openApi/swap/v2/quote/depth", {"symbol": symbol, "limit": str(depth)})
        if r.get("code") == 0:
            data = r.get("data", {})
            bids = data.get("bids", [])
            asks = data.get("asks", [])

            bid = float(bids[0][0]) if bids else 0.0
            ask = float(asks[0][0]) if asks else 0.0

            # Soma dos primeiros 5 níveis de profundidade
            bid_depth_5 = sum(float(b[0]) * float(b[1]) for b in bids[:5]) if bids else 0.0
            ask_depth_5 = sum(float(a[0]) * float(a[1]) for a in asks[:5]) if asks else 0.0

            # Imbalance do order book
            total_depth = bid_depth_5 + ask_depth_5
            bid_ask_imbalance = (bid_depth_5 - ask_depth_5) / total_depth if total_depth > 0 else 0.0

            mid_price = (bid + ask) / 2 if bid > 0 and ask > 0 else 0.0

            # Cache para análise de pressão
            self._order_book_cache[symbol] = {
                "bids": bids[:10],
                "asks": asks[:10],
                "timestamp": time.time()
            }

            return bid, ask, bid_depth_5, ask_depth_5, bid_ask_imbalance, mid_price

        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    async def fetch_cvd(self, symbol: str, hours: int = 24) -> float:
        """
        Cumulative Volume Delta - diferença entre volume de compra e venda.
        Técnica essencial para detectar divergências.
        """
        # Busca klines para calcular CVD aproximado
        r = await self._get("/openApi/swap/v2/quote/klines", {
            "symbol": symbol,
            "interval": "1h",
            "limit": hours
        })

        if r.get("code") != 0:
            return 0.0

        data = r.get("data", [])
        cvd = 0.0
        for candle in data:
            try:
                # Típico: volume de compra = volume * (close - low) / (high - low)
                # Aproximação para CVD
                high = float(candle.get("high", 0))
                low = float(candle.get("low", 0))
                close = float(candle.get("close", 0))
                volume = float(candle.get("volume", 0))

                if high > low:
                    buy_volume = volume * (close - low) / (high - low)
                    sell_volume = volume * (high - close) / (high - low)
                    cvd += buy_volume - sell_volume
            except Exception:
                continue

        return cvd

    async def fetch_tick_quality(self, symbol: str) -> dict:
        """
        Mede qualidade dos ticks: frequência, gaps, latência.
        Essencial para saber se os dados são confiáveis.
        """
        history = self._price_history_detailed.get(symbol, [])
        if len(history) < 10:
            return {"quality": "INSUFFICIENT", "score": 0.3}

        # Calcula timestamps dos últimos snaps
        timestamps = [h.get("ts", 0) for h in history if h.get("ts", 0) > 0]
        if len(timestamps) < 2:
            return {"quality": "INSUFFICIENT", "score": 0.3}

        gaps = [timestamps[i] - timestamps[i-1] for i in range(1, len(timestamps))]
        avg_gap = sum(gaps) / len(gaps) if gaps else 0
        max_gap = max(gaps) if gaps else 0
        expected_gap = 5.0  # 5 segundos esperados

        # Score baseado em gaps
        if max_gap > 15:
            gap_score = 0.3
            quality = "POOR"
        elif max_gap > 10:
            gap_score = 0.6
            quality = "DEGRADED"
        elif avg_gap > expected_gap * 1.5:
            gap_score = 0.7
            quality = "ACCEPTABLE"
        else:
            gap_score = 0.95
            quality = "EXCELLENT"

        # Latência
        latencies = self._latency_history.get(symbol, [])
        if latencies:
            avg_latency = sum(latencies) / len(latencies)
            if avg_latency > 1000:  # > 1 segundo
                latency_score = 0.4
            elif avg_latency > 500:
                latency_score = 0.7
            else:
                latency_score = 0.95
        else:
            latency_score = 0.8

        final_score = (gap_score + latency_score) / 2

        return {
            "quality": quality,
            "score": round(final_score, 3),
            "avg_gap_seconds": round(avg_gap, 2),
            "max_gap_seconds": round(max_gap, 2),
            "avg_latency_ms": round(sum(latencies) / len(latencies), 1) if latencies else 0,
            "samples": len(history)
        }

    def _calc_rsi_approx(self, prices: list[float], n: int = 14) -> float:
        if len(prices) < 2:
            return 50.0
        diffs = [prices[i] - prices[i-1] for i in range(1, len(prices))]
        gains = [d for d in diffs if d > 0]
        losses = [-d for d in diffs if d < 0]
        avg_gain = sum(gains[-n:]) / n if gains else 0.0
        avg_loss = sum(losses[-n:]) / n if losses else 0.0001
        rs = avg_gain / avg_loss
        return round(100 - (100 / (1 + rs)), 1)

    def _calc_real_rsi(self, prices: list[float], period: int = 14) -> float:
        """RSI verdadeiro mais preciso que a aproximação."""
        if len(prices) < period + 1:
            return 50.0

        gains = []
        losses = []

        for i in range(1, len(prices)):
            change = prices[i] - prices[i-1]
            if change > 0:
                gains.append(change)
                losses.append(0)
            else:
                gains.append(0)
                losses.append(abs(change))

        if len(gains) < period:
            return 50.0

        avg_gain = sum(gains[-period:]) / period
        avg_loss = sum(losses[-period:]) / period

        if avg_loss == 0:
            return 100.0

        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

        return rsi

    def _calc_macd(self, prices: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
        """MACD para confirmação de momentum."""
        if len(prices) < slow + signal:
            return {"macd": 0.0, "signal": 0.0, "histogram": 0.0}

        def ema(values: list[float], period: int) -> float:
            if len(values) < period:
                return values[-1] if values else 0.0
            k = 2 / (period + 1)
            ema_val = values[0]
            for val in values[1:period]:
                ema_val = val * k + ema_val * (1 - k)
            for val in values[period:]:
                ema_val = val * k + ema_val * (1 - k)
            return ema_val

        fast_ema = ema(prices[-slow:], fast)
        slow_ema = ema(prices[-slow:], slow)
        macd_line = fast_ema - slow_ema

        # Signal line (EMA do MACD)
        macd_values = []
        for i in range(len(prices) - slow, len(prices)):
            f = ema(prices[:i+1], fast)
            s = ema(prices[:i+1], slow)
            macd_values.append(f - s)

        signal_line = ema(macd_values, signal) if len(macd_values) >= signal else macd_line
        histogram = macd_line - signal_line

        return {
            "macd": round(macd_line, 6),
            "signal": round(signal_line, 6),
            "histogram": round(histogram, 6)
        }

    def _calc_volume_weighted_price(self, history: list[dict]) -> float:
        """VWAP para referência de preço justo."""
        cumulative_pv = 0.0
        cumulative_vol = 0.0

        for h in history:
            price = h.get("price", 0)
            vol = h.get("volume_ratio", 1) * 1000
            if price > 0:
                cumulative_pv += price * vol
                cumulative_vol += vol

        if cumulative_vol == 0:
            return 0.0

        return cumulative_pv / cumulative_vol

    def _calc_price_confidence(self, bid_depth: float, ask_depth: float, spread_bps: float) -> float:
        """
        Calcula confiança no preço baseado na profundidade do book.
        Spread alto ou profundidade baixa = menor confiança.
        """
        confidence = 1.0

        # Penaliza spread alto
        if spread_bps > 10:
            confidence *= 0.7
        elif spread_bps > 5:
            confidence *= 0.85

        # Penaliza profundidade baixa
        total_depth = bid_depth + ask_depth
        if total_depth < 10000:
            confidence *= 0.6
        elif total_depth < 50000:
            confidence *= 0.8

        return round(max(0.3, min(1.0, confidence)), 3)

    def _detect_anomalies(self, snap: MarketSnapshot) -> list[str]:
        """Detecta anomalias com técnicas avançadas."""
        anomalies = []

        # Anomalias existentes
        if snap.oi_change_pct >= 5.0:
            anomalies.append(f"OI_EXPLOSION:+{snap.oi_change_pct:.1f}%")
        if snap.oi_change_pct <= -5.0:
            anomalies.append(f"OI_COLLAPSE:{snap.oi_change_pct:.1f}%")
        if snap.volume_ratio >= 3.0:
            anomalies.append(f"VOL_SURGE:{snap.volume_ratio:.1f}x")
        if abs(snap.funding_rate) >= 0.0005:
            direction = "HIGH" if snap.funding_rate > 0 else "LOW"
            anomalies.append(f"FUNDING_{direction}:{snap.funding_rate:.4f}")
        if snap.spread_bps >= 10:
            anomalies.append(f"WIDE_SPREAD:{snap.spread_bps:.1f}bps")
        if snap.rsi_approx <= 25:
            anomalies.append(f"RSI_OVERSOLD:{snap.rsi_approx:.0f}")
        if snap.rsi_approx >= 75:
            anomalies.append(f"RSI_OVERBOUGHT:{snap.rsi_approx:.0f}")
        if abs(snap.price_change_pct) >= 1.5 and snap.volume_ratio >= 2.0:
            direction = "UP" if snap.price_change_pct > 0 else "DOWN"
            anomalies.append(f"MOMENTUM_{direction}:{snap.price_change_pct:+.2f}%xVOL{snap.volume_ratio:.1f}x")

        # ========== NOVAS ANOMALIAS ==========

        # Order book imbalance extremo
        if abs(snap.bid_ask_imbalance) > 0.6:
            direction = "BUY" if snap.bid_ask_imbalance > 0 else "SELL"
            anomalies.append(f"BOOK_IMBALANCE_{direction}:{snap.bid_ask_imbalance:.2f}")

        # Price confidence baixa
        if snap.price_confidence < 0.6:
            anomalies.append(f"LOW_PRICE_CONFIDENCE:{snap.price_confidence:.2f}")

        # Data quality ruim
        if snap.data_quality_score < 0.7:
            anomalies.append(f"DATA_QUALITY_DEGRADED:{snap.data_quality_score:.2f}")

        # Volume imbalance extremo
        if abs(snap.volume_imbalance) > 0.7:
            direction = "BUY" if snap.volume_imbalance > 0 else "SELL"
            anomalies.append(f"VOLUME_IMBALANCE_{direction}:{snap.volume_imbalance:.2f}")

        # Tick direction streak
        if abs(snap.tick_direction) > 5:
            direction = "UP" if snap.tick_direction > 0 else "DOWN"
            anomalies.append(f"TICK_STREAK_{direction}:{abs(snap.tick_direction)}")

        # Latência alta
        if snap.latency_ms > 500:
            anomalies.append(f"HIGH_LATENCY:{snap.latency_ms:.0f}ms")

        return anomalies

    async def _snapshot_symbol(self, symbol: str) -> Optional[MarketSnapshot]:
        async with self._snapshot_semaphore:
            return await self._snapshot_symbol_unlimited(symbol)

    async def _snapshot_symbol_unlimited(self, symbol: str) -> Optional[MarketSnapshot]:
        start_time = time.time()

        # Busca dados com timeout e retry
        try:
            ticker, funding, oi, (bid, ask, bid_depth, ask_depth, book_imbalance, mid_price) = await asyncio.gather(
                self.fetch_ticker(symbol),
                self.fetch_funding(symbol),
                self.fetch_oi(symbol),
                self.fetch_orderbook(symbol, 10),
            )
        except Exception as e:
            return None

        latency_ms = (time.time() - start_time) * 1000
        self._latency_history[symbol].append(latency_ms)

        if not ticker:
            return None

        try:
            price = float(ticker.get("lastPrice", 0))
            price_change_pct = float(ticker.get("priceChangePercent", 0))
            volume_24h = float(ticker.get("volume", 0))
            high_24h = float(ticker.get("highPrice", price))
            low_24h = float(ticker.get("lowPrice", price))

            # Volume ratio: use short-term increment history (recent candle-style)
            # rather than dividing 24h volume by 24 — gives a real scalp-relevant signal.
            prev_vol_24h = self._prev_volume_24h.get(symbol, 0.0)
            if prev_vol_24h > 0 and volume_24h >= prev_vol_24h:
                vol_increment = volume_24h - prev_vol_24h
                self._volume_increment_history[symbol].append(vol_increment)
            self._prev_volume_24h[symbol] = volume_24h

            increment_history = list(self._volume_increment_history[symbol])
            if len(increment_history) >= 3:
                avg_increment = sum(increment_history[:-1]) / max(len(increment_history) - 1, 1)
                current_increment = increment_history[-1]
                volume_ratio = current_increment / avg_increment if avg_increment > 0 else 1.0
            else:
                # Fallback: use 24h average (initial state before history builds up)
                avg_vol = float(ticker.get("quoteVolume", volume_24h)) / 24 if volume_24h > 0 else 1
                volume_ratio = volume_24h / avg_vol if avg_vol > 0 else 1.0
        except Exception:
            return None

        # Spreads
        spread_bps = ((ask - bid) / price * 10000) if price > 0 and ask > bid else 0.0
        effective_spread_bps = spread_bps * (1 - book_imbalance) if book_imbalance else spread_bps

        atr_pct = ((high_24h - low_24h) / price * 100) if price > 0 else 0.0

        # OI Change
        prev_oi = self._prev_oi.get(symbol, oi)
        oi_change_pct = ((oi - prev_oi) / prev_oi * 100) if prev_oi > 0 else 0.0
        self._prev_oi[symbol] = oi

        # Price history
        price_history = self._prev_prices[symbol]
        price_history.append(price)
        if len(price_history) > 50:
            price_history.pop(0)
        rsi_approx = self._calc_rsi_approx(price_history)
        rsi_real = self._calc_real_rsi(price_history)

        # MACD
        macd = self._calc_macd(price_history)

        # Volume Weighted Price
        detailed_history = list(self._price_history_detailed[symbol])
        vwap = self._calc_volume_weighted_price(detailed_history)

        # Tick direction
        prev_price = self._prev_price.get(symbol, price)
        if price > prev_price:
            tick_direction = 1
        elif price < prev_price:
            tick_direction = -1
        else:
            tick_direction = 0

        # Atualiza cumulative delta (CVD)
        if tick_direction != 0:
            delta_volume = volume_24h / 24 / 3600 * volume_ratio  # volume por segundo aproximado
            self._cumulative_delta[symbol] += delta_volume * tick_direction

        self._prev_price[symbol] = price

        # Volume imbalance (buy vs sell volume aproximado)
        volume_imbalance = self._cumulative_delta[symbol] / (volume_24h + 1) if volume_24h > 0 else 0.0
        volume_imbalance = max(-1.0, min(1.0, volume_imbalance))
        self._volume_imbalance_cache[symbol].append(volume_imbalance)

        # BTC Regime
        if symbol == "BTC-USDT":
            self._btc_change = price_change_pct

        btc_regime = (
            "BULL" if self._btc_change >= 0.5 else
            "BEAR" if self._btc_change <= -0.5 else
            "NEUTRAL"
        )

        # Data quality score
        tick_quality = await self.fetch_tick_quality(symbol)
        data_quality_score = tick_quality["score"]

        # Price confidence
        price_confidence = self._calc_price_confidence(bid_depth, ask_depth, spread_bps)

        # Heartbeat
        self._heartbeat_counter[symbol] += 1

        # Registro detalhado
        self._price_history_detailed[symbol].append({
            "price": price,
            "ts": time.time(),
            "volume": volume_ratio,
            "spread": spread_bps
        })

        self._last_snapshot_time[symbol] = time.time()

        snap = MarketSnapshot(
            symbol=symbol,
            timestamp=time.time(),
            price=price,
            price_change_pct=price_change_pct,
            volume_24h=volume_24h,
            volume_ratio=volume_ratio,
            oi=oi,
            oi_change_pct=oi_change_pct,
            funding_rate=funding,
            bid=bid,
            ask=ask,
            spread_bps=spread_bps,
            high_24h=high_24h,
            low_24h=low_24h,
            atr_pct=atr_pct,
            btc_regime=btc_regime,
            rsi_approx=rsi_approx,
            anomalies=[],
            # NOVOS CAMPOS
            bid_depth_5=bid_depth,
            ask_depth_5=ask_depth,
            bid_ask_imbalance=book_imbalance,
            mid_price=mid_price,
            effective_spread_bps=effective_spread_bps,
            tick_direction=tick_direction,
            cumulative_delta=self._cumulative_delta[symbol],
            volume_imbalance=volume_imbalance,
            bid_volume_24h=bid_depth,
            ask_volume_24h=ask_depth,
            latency_ms=latency_ms,
            data_quality_score=data_quality_score,
            price_confidence=price_confidence,
        )

        snap.anomalies = self._detect_anomalies(snap)
        self._snapshots[symbol] = snap

        return snap

    async def snapshot_all(self) -> dict[str, MarketSnapshot]:
        results = await asyncio.gather(
            *[self._snapshot_symbol(s) for s in SYMBOLS],
            return_exceptions=True
        )
        snaps = {}
        for sym, res in zip(SYMBOLS, results):
            if isinstance(res, MarketSnapshot):
                snaps[sym] = res
                for cb in self._callbacks:
                    try:
                        await cb(res)
                    except Exception:
                        pass
        return snaps

    def get_snapshot(self, symbol: str) -> Optional[MarketSnapshot]:
        return self._snapshots.get(symbol)

    def get_all_snapshots(self) -> dict[str, MarketSnapshot]:
        return dict(self._snapshots)

    def get_cumulative_delta(self, symbol: str) -> float:
        """Retorna CVD atual para o símbolo."""
        return self._cumulative_delta.get(symbol, 0.0)

    def get_data_quality_summary(self) -> dict:
        """Resumo da qualidade dos dados para todos os símbolos."""
        summary = {}
        for sym in SYMBOLS:
            quality = self._snapshots.get(sym)
            if quality:
                summary[sym] = {
                    "quality_score": quality.data_quality_score,
                    "price_confidence": quality.price_confidence,
                    "latency_ms": quality.latency_ms,
                    "heartbeat": self._heartbeat_counter.get(sym, 0)
                }
        return summary

    def to_dict(self, snap: MarketSnapshot) -> dict:
        """Converte snapshot para dicionário com todos os campos."""
        return {
            "symbol": snap.symbol,
            "timestamp": snap.timestamp,
            "price": snap.price,
            "price_change_pct": snap.price_change_pct,
            "volume_ratio": snap.volume_ratio,
            "oi": snap.oi,
            "oi_change_pct": snap.oi_change_pct,
            "funding_rate": snap.funding_rate,
            "spread_bps": snap.spread_bps,
            "atr_pct": snap.atr_pct,
            "rsi": snap.rsi_approx,
            "btc_regime": snap.btc_regime,
            "anomalies": snap.anomalies,
            # NOVOS CAMPOS
            "bid_depth_5": snap.bid_depth_5,
            "ask_depth_5": snap.ask_depth_5,
            "bid_ask_imbalance": snap.bid_ask_imbalance,
            "mid_price": snap.mid_price,
            "effective_spread_bps": snap.effective_spread_bps,
            "tick_direction": snap.tick_direction,
            "cumulative_delta": snap.cumulative_delta,
            "volume_imbalance": snap.volume_imbalance,
            "latency_ms": snap.latency_ms,
            "data_quality_score": snap.data_quality_score,
            "price_confidence": snap.price_confidence,
        }

    async def close(self):
        if self._client:
            await self._client.aclose()
