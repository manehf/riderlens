import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyManualFrameGeometry,
  getAngleBetweenLines,
  getJointAngle,
  getLineAngle,
  normalizeAngle
} from "../src/services/analysis";
import type { FrameGeometry, FrameLine, FramePoint, PoseMetric } from "../src/types/domain";

type GeometryFixtures = {
  lineAngle: Array<{ name: string; line: FrameLine; expected: number }>;
  angleBetweenLines: Array<{ name: string; first: FrameLine; second: FrameLine; expected: number }>;
  jointAngle: Array<{ name: string; first: FramePoint; joint: FramePoint; second: FramePoint; expected: number }>;
  normalizeAngle: Array<{ input: number; expected: number }>;
};

const fixtures = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "geometry.json"), "utf-8")
) as GeometryFixtures;

describe("getLineAngle", () => {
  for (const testCase of fixtures.lineAngle) {
    it(testCase.name, () => {
      expect(getLineAngle(testCase.line)).toBeCloseTo(testCase.expected, 6);
    });
  }
});

describe("getAngleBetweenLines", () => {
  for (const testCase of fixtures.angleBetweenLines) {
    it(testCase.name, () => {
      expect(getAngleBetweenLines(testCase.first, testCase.second)).toBeCloseTo(testCase.expected, 6);
    });
  }
});

describe("getJointAngle", () => {
  for (const testCase of fixtures.jointAngle) {
    it(testCase.name, () => {
      // acos is numerically noisy at the 0/180 boundaries; the app rounds to whole degrees.
      expect(getJointAngle(testCase.first, testCase.joint, testCase.second)).toBeCloseTo(testCase.expected, 3);
    });
  }
});

describe("normalizeAngle", () => {
  for (const testCase of fixtures.normalizeAngle) {
    it(`normalizes ${testCase.input} to ${testCase.expected}`, () => {
      expect(normalizeAngle(testCase.input)).toBe(testCase.expected);
    });
  }
});

describe("applyManualFrameGeometry", () => {
  const metric: PoseMetric = {
    id: "metric-test",
    sessionId: "session-test",
    phase: "takeoff",
    frameTime: 2.5,
    torsoAngle: 0,
    hipAngle: 0,
    kneeAngle: 0,
    elbowAngle: 0,
    bikePitchAngle: 0,
    confidence: 0
  };

  const geometry: FrameGeometry = {
    floor: { start: { x: 0, y: 0.9 }, end: { x: 1, y: 0.9 } },
    tireBaseline: { start: { x: 0.2, y: 0.8 }, end: { x: 0.8, y: 0.8 } },
    torso: { start: { x: 0.5, y: 0.6 }, end: { x: 0.5, y: 0.3 } },
    kneeUpper: { start: { x: 0.5, y: 0.6 }, end: { x: 0.5, y: 0.7 } },
    kneeLower: { start: { x: 0.5, y: 0.7 }, end: { x: 0.6, y: 0.8 } },
    landing: { start: { x: 0.6, y: 0.85 }, end: { x: 1, y: 0.95 } }
  };

  it("marks the metric as manual with high confidence and computed angles", () => {
    const result = applyManualFrameGeometry(metric, geometry, 3.1);

    expect(result.geometrySource).toBe("manual");
    expect(result.confidence).toBe(0.95);
    expect(result.frameTime).toBe(3.1);
    expect(result.geometry).toEqual(geometry);
    // Vertical torso against a flat floor reads 90 degrees.
    expect(result.torsoAngle).toBe(90);
    // Hip->knee straight down, knee->ankle 45 down-right: joint angle 135.
    expect(result.kneeAngle).toBe(135);
    expect(result.floorAngle).toBe(0);
    expect(result.tireBaselineAngle).toBe(0);
    expect(result.bikePitchAngle).toBe(0);
  });

  it("keeps the original frame time when none is given", () => {
    expect(applyManualFrameGeometry(metric, geometry).frameTime).toBe(2.5);
  });
});
