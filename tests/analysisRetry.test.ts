import { describe, expect, it } from "vitest";
import { analysisRequestId, analysisRetryDelay, isCurrentAnalysisAttempt, parseRetryAfter, SerialAnalysisQueue } from "../src/services/analysisRetry";
import type { JumpRecord } from "../src/types/domain";

describe("analysis attempt ownership", () => {
  it("rejects a delayed result or failure after reselecting the same record", () => {
    const original = { id: "record-one", analysisAttemptId: "attempt-one", windowStart: 0, windowEnd: 4 } as JumpRecord;
    const requestId = analysisRequestId(original);
    expect(isCurrentAnalysisAttempt({ ...original, status: "pending" }, requestId)).toBe(true);
    expect(isCurrentAnalysisAttempt({ ...original, analysisAttemptId: "attempt-two", windowStart: 4, windowEnd: 8 }, requestId)).toBe(false);
    expect(isCurrentAnalysisAttempt(undefined, requestId)).toBe(false);
  });

  it("keeps migrated legacy retries stable but rejects another trim or rotation", () => {
    const legacy = { id: "legacy", windowStart: 0, windowEnd: 4 } as JumpRecord;
    const requestId = analysisRequestId(legacy);
    expect(isCurrentAnalysisAttempt({ ...legacy, analysisAttemptId: requestId }, requestId)).toBe(true);
    expect(isCurrentAnalysisAttempt({ ...legacy, rotateDegrees: 90 }, requestId)).toBe(false);
    expect(isCurrentAnalysisAttempt({ ...legacy, windowEnd: 5 }, requestId)).toBe(false);
  });
});

describe("analysis retry timing", () => {
  it("respects delta seconds and HTTP dates, ignoring malformed values", () => {
    const now = Date.parse("2026-09-08T12:00:00Z");
    expect(parseRetryAfter("45", now)).toBe(45_000);
    expect(parseRetryAfter("Tue, 08 Sep 2026 12:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Tue, 08 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("later", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("backs off, caps exponential growth and never shortens the server delay", () => {
    expect(analysisRetryDelay(1, undefined, 0)).toBe(30_000);
    expect(analysisRetryDelay(2, undefined, 0.5)).toBe(62_500);
    expect(analysisRetryDelay(100, undefined, 0)).toBe(300_000);
    expect(analysisRetryDelay(1, 600_000, 0.5)).toBe(602_500);
  });
});

describe("shared analysis FIFO", () => {
  it("serializes different records and deduplicates the same pending record", async () => {
    const queue = new SerialAnalysisQueue();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.enqueue("initial", async () => { calls.push("first:start"); await gate; calls.push("first:end"); });
    const second = queue.enqueue("manual", async () => { calls.push("second"); });
    const duplicate = queue.enqueue("initial", async () => { calls.push("duplicate"); });
    await Promise.resolve();
    expect(calls).toEqual(["first:start"]);
    release();
    await Promise.all([first, second, duplicate]);
    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows later records and a future retry after a task rejects", async () => {
    const queue = new SerialAnalysisQueue();
    await expect(queue.enqueue("one", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    let completed = 0;
    await queue.enqueue("two", async () => { completed++; });
    await queue.enqueue("one", async () => { completed++; });
    expect(completed).toBe(2);
  });
});
