import assert from "node:assert/strict";
import test from "node:test";
import {
  BINGX_ENDPOINTS,
  assertLiveExecutionAllowed,
  createExecutionCredentials,
  endpointForCredentials,
  sanitizeForOutput,
  validateExecutionStartup,
} from "../executionSecurity.ts";

const demoCredentials = createExecutionCredentials({
  environment: "demo",
  accountId: "demo-account",
  apiKey: "demo-api-key-value",
  secretKey: "demo-secret-key-value",
  source: "demo-connect",
});

test("demo credentials can only resolve the VST endpoint", () => {
  assert.equal(endpointForCredentials(demoCredentials, "demo"), BINGX_ENDPOINTS.demo);
  assert.throws(() => endpointForCredentials(demoCredentials, "live"), /cannot route to live/);
});

test("real execution requires explicit live configuration and optionally enforces account identity", () => {
  const liveCredentials = createExecutionCredentials({
    environment: "live",
    accountId: "approved-live-account",
    apiKey: "live-api-key-value",
    secretKey: "live-secret-key-value",
    source: "live-connect",
  });
  const env = {
    EXECUTION_ENV: "live",
    REAL_EXECUTION_ENABLED: "true",
    REAL_EXECUTION_CONFIRMATION: "I_ACKNOWLEDGE_REAL_MONEY",
  };
  assert.doesNotThrow(() => assertLiveExecutionAllowed(liveCredentials, env));
  const accountLockedEnv = {
    ...env,
    LIVE_ACCOUNT_ID: "approved-live-account",
  };
  assert.doesNotThrow(() => assertLiveExecutionAllowed(liveCredentials, accountLockedEnv));
  assert.throws(
    () => assertLiveExecutionAllowed({ ...liveCredentials, accountId: "other-account" }, accountLockedEnv),
    /does not match LIVE_ACCOUNT_ID/,
  );
});

test("startup refuses environment and credential disagreement", () => {
  assert.throws(
    () => validateExecutionStartup({ EXECUTION_ENV: "demo", BINGX_CREDENTIAL_ENV: "live" }),
    /disagrees/,
  );
  assert.throws(
    () => validateExecutionStartup({ EXECUTION_ENV: "live", REAL_EXECUTION_ENABLED: "false" }),
    /requires REAL_EXECUTION_ENABLED=true/,
  );
  assert.throws(
    () => validateExecutionStartup({
      EXECUTION_ENV: "live",
      REAL_EXECUTION_ENABLED: "true",
      REAL_EXECUTION_CONFIRMATION: "I_ACKNOWLEDGE_REAL_MONEY",
      ADMIN_API_TOKEN: "short",
    }),
    /ADMIN_API_TOKEN must be at least 32 characters/,
  );
});

test("secrets are removed from nested API, log and error-shaped values", () => {
  const secret = "never-print-this-secret";
  const serialized = JSON.stringify(sanitizeForOutput({
    apiKey: secret,
    nested: { secretKey: secret, authorization: `Bearer ${secret}` },
    err: new Error(`request failed secret=${secret}`),
    message: `token=${secret}`,
  }));
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("[REDACTED]"), true);
});
