import { createHash, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

export type ExecutionEnvironment = "demo" | "live";

export interface ExecutionCredentials {
  environment: ExecutionEnvironment;
  accountId: string;
  apiKey: string;
  secretKey: string;
  fingerprint: string;
  source: "demo-connect" | "live-connect";
  verifiedAt: number;
}

export const BINGX_ENDPOINTS: Record<ExecutionEnvironment, string> = {
  demo: "https://open-api-vst.bingx.com",
  live: "https://open-api.bingx.com",
};

const LIVE_CONFIRMATION = "I_ACKNOWLEDGE_REAL_MONEY";
const MIN_ADMIN_TOKEN_LENGTH = 32;
const SECRET_KEY_PATTERN = /(authorization|cookie|password|secret|token|api[-_]?key|signature)/i;
const SECRET_VALUE_PATTERN = /((?:api[-_]?key|secret|token|authorization|signature)\s*[=:]\s*)[^\s,;]+/gi;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Startup refused: ${key} is required.`);
  return value;
}

export function validateExecutionStartup(env: NodeJS.ProcessEnv = process.env): {
  environment: ExecutionEnvironment;
  liveExecutionEnabled: boolean;
} {
  const rawEnvironment = (env.EXECUTION_ENV ?? "demo").trim().toLowerCase();
  if (rawEnvironment !== "demo" && rawEnvironment !== "live") {
    throw new Error('Startup refused: EXECUTION_ENV must be exactly "demo" or "live".');
  }

  const environment = rawEnvironment as ExecutionEnvironment;
  const liveExecutionEnabled = env.REAL_EXECUTION_ENABLED === "true";
  const credentialEnvironment = env.BINGX_CREDENTIAL_ENV?.trim().toLowerCase();

  if (credentialEnvironment && credentialEnvironment !== environment) {
    throw new Error(
      `Startup refused: BINGX_CREDENTIAL_ENV=${credentialEnvironment} disagrees with EXECUTION_ENV=${environment}.`,
    );
  }

  if (environment === "demo" && liveExecutionEnabled) {
    throw new Error("Startup refused: REAL_EXECUTION_ENABLED=true is invalid in demo environment.");
  }

  if (environment === "live") {
    if (!liveExecutionEnabled) {
      throw new Error("Startup refused: live environment requires REAL_EXECUTION_ENABLED=true.");
    }
    if (required(env, "REAL_EXECUTION_CONFIRMATION") !== LIVE_CONFIRMATION) {
      throw new Error("Startup refused: REAL_EXECUTION_CONFIRMATION is invalid.");
    }
    required(env, "LIVE_ACCOUNT_ID");
    const adminToken = required(env, "ADMIN_API_TOKEN");
    if (adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
      throw new Error(`Startup refused: ADMIN_API_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters in live environment.`);
    }
    if (env.LOAD_PERSISTED_CONFIG === "true") {
      throw new Error("Startup refused: live execution cannot load persisted runtime configuration.");
    }
  }

  return { environment, liveExecutionEnabled };
}

export function isLiveExecutionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const state = validateExecutionStartup(env);
    return state.environment === "live" && state.liveExecutionEnabled;
  } catch {
    return false;
  }
}

export function credentialFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export function createExecutionCredentials(input: {
  environment: ExecutionEnvironment;
  accountId: string;
  apiKey: string;
  secretKey: string;
  source: ExecutionCredentials["source"];
}): ExecutionCredentials {
  const accountId = input.accountId.trim();
  const apiKey = input.apiKey.trim();
  const secretKey = input.secretKey.trim();
  if (!accountId || !apiKey || !secretKey) {
    throw new Error("accountId, apiKey and secretKey are required.");
  }
  return {
    ...input,
    accountId,
    apiKey,
    secretKey,
    fingerprint: credentialFingerprint(apiKey),
    verifiedAt: Date.now(),
  };
}

export function endpointForCredentials(
  credentials: Pick<ExecutionCredentials, "environment">,
  requestedEnvironment: ExecutionEnvironment,
): string {
  if (credentials.environment !== requestedEnvironment) {
    throw new Error(
      `Execution refused: ${credentials.environment} credentials cannot route to ${requestedEnvironment}.`,
    );
  }
  return BINGX_ENDPOINTS[requestedEnvironment];
}

export function assertLiveExecutionAllowed(
  credentials: Pick<ExecutionCredentials, "environment" | "accountId">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const startup = validateExecutionStartup(env);
  if (startup.environment !== "live" || credentials.environment !== "live") {
    throw new Error("Real-money execution refused: environment is not live.");
  }
  if (credentials.accountId !== env.LIVE_ACCOUNT_ID?.trim()) {
    throw new Error("Real-money execution refused: credential account identity does not match LIVE_ACCOUNT_ID.");
  }
}

export function sanitizeForOutput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.replace(SECRET_VALUE_PATTERN, "$1[REDACTED]"),
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForOutput(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeForOutput(item, seen),
      ]),
    );
  }
  if (typeof value === "string") return value.replace(SECRET_VALUE_PATTERN, "$1[REDACTED]");
  return value;
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function requireAdminAuthorization(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_TOKEN?.trim();
  const actual = req.header("x-admin-token")?.trim() ?? "";
  if (!expected || !actual || !tokenMatches(actual, expected)) {
    res.status(403).json({ error: "Administrative authorization required." });
    return;
  }
  next();
}
