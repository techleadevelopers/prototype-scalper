/**
 * bingxHttp.ts — BingX REST API utilities
 *
 * Sign + POST/GET helpers shared between bot.ts e gridTriggerManager.ts.
 * As funções locais em bot.ts são idênticas — manter em sincronia se modificar.
 *
 * Melhorias de produção:
 *   - res.ok verificado antes de .json() — evita SyntaxError em 5xx HTML
 *   - Retry automático com backoff exponencial para falhas transientes (exceto 4xx)
 *   - Timeout configurável via BINGX_REQUEST_TIMEOUT_MS (default 8 000ms)
 */

import { createHmac } from "crypto";

export const BINGX_BASE = "https://open-api.bingx.com";

const BINGX_REQUEST_TIMEOUT_MS = Number(process.env["BINGX_REQUEST_TIMEOUT_MS"] ?? 8_000);
const BINGX_MAX_RETRIES = Math.max(0, Number(process.env["BINGX_MAX_RETRIES"] ?? 2));
const BINGX_RETRY_BASE_MS = Math.max(50, Number(process.env["BINGX_RETRY_BASE_MS"] ?? 200));

function sign(params: Record<string, string | number | undefined>, secretKey: string): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secretKey).update(query).digest("hex");
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa fetch com retry automático em falhas transientes.
 * Não faz retry em erros 4xx (cliente) — somente 5xx ou erros de rede.
 */
async function _fetchWithRetry(
  url: string,
  init: RequestInit,
  method: "GET" | "POST",
): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BINGX_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await _sleep(BINGX_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS) });
      if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        // 4xx = erro do cliente, não faz retry
        if (res.status >= 400 && res.status < 500) {
          return { code: -1, msg: `HTTP ${res.status}: ${body.slice(0, 300)}` };
        }
        // 5xx = transitório, faz retry
        lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        continue;
      }
      const text = await res.text();
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { code: -1, msg: `JSON parse error: ${text.slice(0, 200)}` };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return { code: -1, msg: `network_error after ${BINGX_MAX_RETRIES + 1} attempts: ${msg}` };
}

export async function bingxPost(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  return _fetchWithRetry(url, { method: "POST", headers: { "X-BX-APIKEY": apiKey } }, "POST");
}

export async function bingxGet(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
  secretKey: string,
): Promise<Record<string, unknown>> {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secretKey);
  const qs = Object.entries(allParams)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${BINGX_BASE}${path}?${qs}&signature=${signature}`;
  return _fetchWithRetry(url, { method: "GET", headers: { "X-BX-APIKEY": apiKey } }, "GET");
}
