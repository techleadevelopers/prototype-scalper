/**
 * bingxHttp.ts — BingX REST API utilities
 *
 * Sign + POST/GET helpers shared between bot.ts e gridTriggerManager.ts.
 * As funções locais em bot.ts são idênticas — manter em sincronia se modificar.
 */

import { createHmac } from "crypto";

export const BINGX_BASE = "https://open-api.bingx.com";

const BINGX_REQUEST_TIMEOUT_MS = Number(process.env["BINGX_REQUEST_TIMEOUT_MS"] ?? 8_000);

function sign(params: Record<string, string | number | undefined>, secretKey: string): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secretKey).update(query).digest("hex");
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
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
  const res = await fetch(url, {
    headers: { "X-BX-APIKEY": apiKey },
    signal: AbortSignal.timeout(BINGX_REQUEST_TIMEOUT_MS),
  });
  return res.json() as Promise<Record<string, unknown>>;
}
