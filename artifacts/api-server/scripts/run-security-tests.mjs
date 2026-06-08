import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

const tests = [
  "src/lib/__tests__/executionSecurity.node.test.ts",
  "src/lib/__tests__/incidentEngine.node.test.ts",
];

try {
  for (const [index, entryPoint] of tests.entries()) {
    const output = resolve(`.security-test-${index}.cjs`);
    buildSync({
      entryPoints: [entryPoint],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      logLevel: "silent",
    });
    const result = spawnSync(process.execPath, ["--test", output], { stdio: "inherit" });
    if ((result.status ?? 1) !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  for (const index of tests.keys()) {
    rmSync(resolve(`.security-test-${index}.cjs`), { force: true });
  }
}
