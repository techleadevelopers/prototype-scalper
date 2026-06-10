/**
 * sectorMap.ts
 *
 * Sistema 2: Sector Cluster Co-Movement Filter
 *
 * Define os clusters de correlação para cada símbolo operado. O backend usa
 * este mapa para cancelar gatilhos cascata do mesmo setor antes de armar um
 * novo — evitando ilusão de diversificação em scalping em massa.
 *
 * Setores:
 *   LAYER_1   — redes base (BTC, ETH, SOL, POL). Alta correlação sistêmica.
 *   AI_INFRA  — infraestrutura de IA on-chain (NEAR). Move com narrativa de IA.
 *   DEFI      — DeFi / exchange descentralizado (VVV, HYPE). Correlação de yield.
 *   MEME      — memecoins / tokens políticos (TRUMP, MELANIA, BEAT). Correlação
 *               de apetite por risco e liquidez especulativa.
 *   OTHER     — fallback para símbolos não mapeados.
 *
 * Regra de cascade: máximo 1 gatilho ativo por sectorCluster.
 */

export type SectorCluster = "LAYER_1" | "AI_INFRA" | "DEFI" | "MEME" | "OTHER";

const SYMBOL_SECTOR: Record<string, SectorCluster> = {
  "BTC-USDT":     "LAYER_1",
  "ETH-USDT":     "LAYER_1",
  "SOL-USDT":     "LAYER_1",
  "POL-USDT":     "LAYER_1",
  "NEAR-USDT":    "AI_INFRA",
  "VVV-USDT":     "DEFI",
  "HYPE-USDT":    "DEFI",
  "TRUMP-USDT":   "MEME",
  "MELANIA-USDT": "MEME",
  "BEAT-USDT":    "MEME",
};

export function getSectorCluster(symbol: string): SectorCluster {
  return SYMBOL_SECTOR[symbol] ?? "OTHER";
}

export { SYMBOL_SECTOR };
