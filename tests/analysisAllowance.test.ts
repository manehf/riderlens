import { describe, expect, it } from "vitest";

import {
  FREE_ANALYSIS_LIMIT,
  getFreeAnalysesRemaining,
  normalizeFreeAnalysesUsed
} from "../src/services/analysisAllowance";

describe("analysis allowance", () => {
  it("starts every new installation with three free analyses", () => {
    expect(getFreeAnalysesRemaining(0)).toBe(FREE_ANALYSIS_LIMIT);
  });

  it("does not return analyses after the limit is exhausted", () => {
    expect(getFreeAnalysesRemaining(3)).toBe(0);
    expect(getFreeAnalysesRemaining(8)).toBe(0);
  });

  it("normalizes invalid persisted usage safely", () => {
    expect(normalizeFreeAnalysesUsed(undefined)).toBe(0);
    expect(normalizeFreeAnalysesUsed("2")).toBe(2);
    expect(normalizeFreeAnalysesUsed(-1)).toBe(0);
    expect(normalizeFreeAnalysesUsed(2.9)).toBe(2);
  });
});
