/**
 * TriggerStrategy — gatilho de entrada por desvio de preço.
 *
 * Lógica:
 *   - Ao ativar, captura o preço de referência de cada símbolo.
 *   - Se o preço CAIR >= longDropPct % → dispara LONG; TP = volta ao preço de referência.
 *   - Se o preço SUBIR >= shortRisePct % → dispara SHORT; TP = volta ao preço de referência.
 *   - Cooldown por símbolo/direção para evitar múltiplos disparo seguidos.
 *   - Reset de referência manual ou automático (configurable).
 */

export interface TriggerConfig {
  enabled: boolean;
  longDropPct: number;
  shortRisePct: number;
  slPct: number;
  cooldownMs: number;
  autoResetAfterFireMs: number;
  symbols: string[];
}

export interface TriggerSignal {
  symbol: string;
  direction: "LONG" | "SHORT";
  referencePrice: number;
  entryPrice: number;
  tpPct: number;
  slPct: number;
  triggerDropRisePct: number;
}

export interface SymbolTriggerState {
  symbol: string;
  referencePrice: number;
  referenceSetAt: number;
  currentPrice: number | null;
  currentPriceFetchedAt: number | null;
  dropPct: number;
  risePct: number;
  longArmed: boolean;
  shortArmed: boolean;
  longTriggerPrice: number;
  shortTriggerPrice: number;
  longTpPct: number;
  shortTpPct: number;
  longFiredAt: number | null;
  shortFiredAt: number | null;
}

const DEFAULT_CONFIG: TriggerConfig = {
  enabled: false,
  longDropPct: 1.74,
  shortRisePct: 3.16,
  slPct: 0.55,
  cooldownMs: 5 * 60 * 1000,
  autoResetAfterFireMs: 0,
  symbols: [],
};

let _config: TriggerConfig = { ...DEFAULT_CONFIG };
const _states = new Map<string, SymbolTriggerState>();

export function getTriggerConfig(): TriggerConfig {
  return { ..._config };
}

export function setTriggerConfig(patch: Partial<TriggerConfig>): TriggerConfig {
  _config = { ..._config, ...patch };
  if (!_config.enabled) {
    _states.clear();
  }
  return { ..._config };
}

export function snapshotReferencePrice(symbol: string, price: number): void {
  const now = Date.now();
  const longDrop = _config.longDropPct;
  const shortRise = _config.shortRisePct;
  const longTriggerPrice = price * (1 - longDrop / 100);
  const shortTriggerPrice = price * (1 + shortRise / 100);
  const longTpPct = (longDrop / (1 - longDrop / 100));
  const shortTpPct = (shortRise / (1 + shortRise / 100));

  _states.set(symbol, {
    symbol,
    referencePrice: price,
    referenceSetAt: now,
    currentPrice: price,
    currentPriceFetchedAt: now,
    dropPct: 0,
    risePct: 0,
    longArmed: false,
    shortArmed: false,
    longTriggerPrice,
    shortTriggerPrice,
    longTpPct,
    shortTpPct,
    longFiredAt: null,
    shortFiredAt: null,
  });
}

export function snapshotAllReferencesByPrice(prices: Map<string, number>): void {
  const symbols = _config.symbols.length > 0 ? _config.symbols : [...prices.keys()];
  for (const sym of symbols) {
    const price = prices.get(sym);
    if (price && price > 0) snapshotReferencePrice(sym, price);
  }
}

export function updateCurrentPrice(symbol: string, price: number): void {
  const state = _states.get(symbol);
  if (!state) return;
  const now = Date.now();
  const dropPct = ((state.referencePrice - price) / state.referencePrice) * 100;
  const risePct = ((price - state.referencePrice) / state.referencePrice) * 100;
  state.currentPrice = price;
  state.currentPriceFetchedAt = now;
  state.dropPct = dropPct;
  state.risePct = risePct;
  state.longArmed = dropPct >= _config.longDropPct;
  state.shortArmed = risePct >= _config.shortRisePct;
}

export function checkAndFireTriggers(now: number = Date.now()): TriggerSignal[] {
  if (!_config.enabled) return [];
  const signals: TriggerSignal[] = [];

  for (const state of _states.values()) {
    if (!state.currentPrice || state.currentPrice <= 0) continue;

    if (state.longArmed) {
      const lastFire = state.longFiredAt ?? 0;
      if (now - lastFire >= _config.cooldownMs) {
        const tpPct = state.longTpPct;
        signals.push({
          symbol: state.symbol,
          direction: "LONG",
          referencePrice: state.referencePrice,
          entryPrice: state.currentPrice,
          tpPct,
          slPct: _config.slPct,
          triggerDropRisePct: state.dropPct,
        });
        state.longFiredAt = now;
        state.longArmed = false;
        if (_config.autoResetAfterFireMs > 0) {
          setTimeout(() => {
            if (state.currentPrice && state.currentPrice > 0) {
              snapshotReferencePrice(state.symbol, state.currentPrice);
            }
          }, _config.autoResetAfterFireMs);
        }
      }
    }

    if (state.shortArmed) {
      const lastFire = state.shortFiredAt ?? 0;
      if (now - lastFire >= _config.cooldownMs) {
        const tpPct = state.shortTpPct;
        signals.push({
          symbol: state.symbol,
          direction: "SHORT",
          referencePrice: state.referencePrice,
          entryPrice: state.currentPrice,
          tpPct,
          slPct: _config.slPct,
          triggerDropRisePct: state.risePct,
        });
        state.shortFiredAt = now;
        state.shortArmed = false;
        if (_config.autoResetAfterFireMs > 0) {
          setTimeout(() => {
            if (state.currentPrice && state.currentPrice > 0) {
              snapshotReferencePrice(state.symbol, state.currentPrice);
            }
          }, _config.autoResetAfterFireMs);
        }
      }
    }
  }

  return signals;
}

export function getTriggerStates(): SymbolTriggerState[] {
  return [..._states.values()];
}

export function getTriggerState(symbol: string): SymbolTriggerState | null {
  return _states.get(symbol) ?? null;
}

export function resetTriggerState(symbol?: string): void {
  if (symbol) {
    _states.delete(symbol);
  } else {
    _states.clear();
  }
}

export function isTriggerEnabled(): boolean {
  return _config.enabled;
}

export function getTriggerSummary(): {
  enabled: boolean;
  symbolCount: number;
  longDropPct: number;
  shortRisePct: number;
  slPct: number;
  armedLong: number;
  armedShort: number;
  symbols: Array<{
    symbol: string;
    referencePrice: number;
    currentPrice: number | null;
    dropPct: number;
    risePct: number;
    longArmed: boolean;
    shortArmed: boolean;
    longTriggerPrice: number;
    shortTriggerPrice: number;
    longTpPct: number;
    shortTpPct: number;
    longFiredAt: number | null;
    shortFiredAt: number | null;
    secondsSinceSnapshot: number;
  }>;
} {
  const states = getTriggerStates();
  const now = Date.now();
  return {
    enabled: _config.enabled,
    symbolCount: states.length,
    longDropPct: _config.longDropPct,
    shortRisePct: _config.shortRisePct,
    slPct: _config.slPct,
    armedLong: states.filter((s) => s.longArmed).length,
    armedShort: states.filter((s) => s.shortArmed).length,
    symbols: states.map((s) => ({
      symbol: s.symbol,
      referencePrice: s.referencePrice,
      currentPrice: s.currentPrice,
      dropPct: s.dropPct,
      risePct: s.risePct,
      longArmed: s.longArmed,
      shortArmed: s.shortArmed,
      longTriggerPrice: s.longTriggerPrice,
      shortTriggerPrice: s.shortTriggerPrice,
      longTpPct: s.longTpPct,
      shortTpPct: s.shortTpPct,
      longFiredAt: s.longFiredAt,
      shortFiredAt: s.shortFiredAt,
      secondsSinceSnapshot: Math.round((now - s.referenceSetAt) / 1000),
    })),
  };
}
