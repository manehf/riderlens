import { describe, expect, it } from "vitest";

import {
  consumeFreeAnalysis,
  currentAllowanceMonth,
  FREE_ANALYSIS_LIMIT,
  getFreeAnalysesRemaining,
  normalizeFreeAnalysesUsed,
  usedThisMonth
} from "../src/services/analysisAllowance";

const JULY = new Date(2026, 6, 14, 10, 0, 0);
const AUGUST = new Date(2026, 7, 1, 0, 0, 1);

describe("analysis allowance", () => {
  it("starts every new installation with three free analyses", () => {
    expect(getFreeAnalysesRemaining(undefined, JULY)).toBe(FREE_ANALYSIS_LIMIT);
  });

  it("blocks within the month once the limit is spent", () => {
    expect(getFreeAnalysesRemaining({ month: "2026-07", used: 3 }, JULY)).toBe(0);
    expect(getFreeAnalysesRemaining({ month: "2026-07", used: 8 }, JULY)).toBe(0);
  });

  it("renews the allowance when a new month starts", () => {
    const exhaustedInJuly = { month: "2026-07", used: 3 };
    expect(getFreeAnalysesRemaining(exhaustedInJuly, AUGUST)).toBe(FREE_ANALYSIS_LIMIT);
    expect(usedThisMonth(exhaustedInJuly, AUGUST)).toBe(0);
  });

  it("consuming increments within the month and restarts across the boundary", () => {
    const first = consumeFreeAnalysis(undefined, JULY);
    expect(first).toEqual({ month: "2026-07", used: 1 });

    const second = consumeFreeAnalysis(first, JULY);
    expect(second).toEqual({ month: "2026-07", used: 2 });

    // Month flips mid-session: the new month starts at 1, not 3.
    const acrossBoundary = consumeFreeAnalysis(second, AUGUST);
    expect(acrossBoundary).toEqual({ month: "2026-08", used: 1 });
  });

  it("keys months in local time with zero padding", () => {
    expect(currentAllowanceMonth(new Date(2026, 0, 31, 23, 59, 59))).toBe("2026-01");
    expect(currentAllowanceMonth(new Date(2026, 11, 1))).toBe("2026-12");
    // One minute apart across local midnight lands in different months.
    expect(currentAllowanceMonth(new Date(2026, 6, 31, 23, 59))).not.toBe(
      currentAllowanceMonth(new Date(2026, 7, 1, 0, 0))
    );
  });

  it("normalizes invalid persisted usage safely", () => {
    expect(normalizeFreeAnalysesUsed(undefined)).toBe(0);
    expect(normalizeFreeAnalysesUsed("2")).toBe(2);
    expect(normalizeFreeAnalysesUsed(-1)).toBe(0);
    expect(normalizeFreeAnalysesUsed(2.9)).toBe(2);
    expect(getFreeAnalysesRemaining({ month: "2026-07", used: Number.NaN }, JULY)).toBe(FREE_ANALYSIS_LIMIT);
  });
});
