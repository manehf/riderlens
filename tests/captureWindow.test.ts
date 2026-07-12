import { describe, expect, it } from "vitest";

import {
  fitAnalysisWindow,
  MAX_ANALYSIS_WINDOW_SECONDS,
  shouldLoopSelection,
  updateAnalysisWindow
} from "../src/services/captureWindow";

describe("fitAnalysisWindow", () => {
  it("keeps a short user-selected jump unchanged", () => {
    expect(fitAnalysisWindow(4, 9, 20)).toEqual({ start: 4, end: 9 });
  });

  it("centers the maximum window inside a long initial selection", () => {
    expect(fitAnalysisWindow(0, 30, 30)).toEqual({ start: 11, end: 19 });
  });

  it("never returns more than the worker limit", () => {
    const window = fitAnalysisWindow(15, 30, 30);
    expect(window.end - window.start).toBe(MAX_ANALYSIS_WINDOW_SECONDS);
    expect(window.end).toBeLessThanOrEqual(30);
  });
});

describe("updateAnalysisWindow", () => {
  it("keeps the end fixed when the start reaches the eight-second limit", () => {
    expect(updateAnalysisWindow({ start: 11, end: 19 }, { start: 5 }, 30)).toEqual({ start: 11, end: 19 });
  });

  it("keeps the start fixed when the end reaches the eight-second limit", () => {
    expect(updateAnalysisWindow({ start: 11, end: 19 }, { end: 25 }, 30)).toEqual({ start: 11, end: 19 });
  });

  it("allows either edge to shorten the selection", () => {
    expect(updateAnalysisWindow({ start: 11, end: 19 }, { end: 16 }, 30)).toEqual({ start: 11, end: 16 });
  });

  it("prevents the start from crossing the fixed end", () => {
    expect(updateAnalysisWindow({ start: 11, end: 19 }, { start: 20 }, 30)).toEqual({ start: 18.5, end: 19 });
  });

  it("prevents the end from crossing the fixed start", () => {
    expect(updateAnalysisWindow({ start: 11, end: 19 }, { end: 10 }, 30)).toEqual({ start: 11, end: 11.5 });
  });
});

describe("shouldLoopSelection", () => {
  it("keeps a paused manual seek on the selected end frame", () => {
    expect(shouldLoopSelection(false, 4, 4)).toBe(false);
  });

  it("loops active playback when it reaches the selected end", () => {
    expect(shouldLoopSelection(true, 4, 4)).toBe(true);
  });
});
