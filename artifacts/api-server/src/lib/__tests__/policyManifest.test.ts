import { describe, expect, it } from "vitest";
import { canonicalJson, hashEffectiveConfig } from "../policyManifest";

describe("policy manifest hashing", () => {
  it("changes when an effective threshold changes", () => {
    const base = {
      config: {
        sniperMinCombinedScore: 0.2,
        candleMinScore: 0.5,
      },
    };
    const changed = {
      config: {
        sniperMinCombinedScore: 0.25,
        candleMinScore: 0.5,
      },
    };

    expect(hashEffectiveConfig(base)).not.toBe(hashEffectiveConfig(changed));
  });

  it("does not change when object keys are ordered differently", () => {
    const left = {
      policyVersion: "p1",
      config: {
        b: 2,
        a: 1,
      },
    };
    const right = {
      config: {
        a: 1,
        b: 2,
      },
      policyVersion: "p1",
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(hashEffectiveConfig(left)).toBe(hashEffectiveConfig(right));
  });
});
