import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

const output = resolve(".security-test.cjs");

try {
  buildSync({
    entryPoints: ["src/lib/__tests__/executionSecurity.node.test.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
  });
  const result = spawnSync(process.execPath, ["--test", output], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { force: true });
}
