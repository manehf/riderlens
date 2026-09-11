import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/analysisWorker", () => ({ getWorkerUrlCandidates: () => ["https://worker.example"] }));

const input = { videoUri: "file:///clip.mp4", requestId: "analysis-test-123", startSeconds: 0, endSeconds: 4 };
const payload = { clip: "data:video/mp4;base64,eA==", skeletonClip: null, window: { start: 0, end: 4 }, series: [], filmstrip: [], events: [], flight: null };
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });

describe("capture API compatibility and recovery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("keeps the final synchronous response contract for an older worker", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "ok" })).mockResolvedValueOnce(json(payload));
    const { processRecord } = await import("../src/services/capture");
    expect(await processRecord(input)).toEqual(payload);
    expect(fetchMock.mock.calls[1][0]).toBe("https://worker.example/capture/record");
  });

  it("submits a negotiated async job and exposes its ID for durable polling", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "queued", retryAfterSeconds: 15 }, 202));
    const { processRecord, RecordWaitingError } = await import("../src/services/capture");
    const error = await processRecord(input).catch((error) => error);
    expect(error).toBeInstanceOf(RecordWaitingError);
    expect(error).toMatchObject({ jobId: input.requestId, retryAfterMs: 15_000 });
    expect(fetchMock.mock.calls[1][0]).toBe("https://worker.example/capture/jobs");
    expect(fetchMock.mock.calls[1][1].body.get("request_id")).toBe(input.requestId);
  });

  it("polls an existing job without uploading the video again", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "processing", retryAfterSeconds: 10 }));
    const { processRecord, RecordWaitingError } = await import("../src/services/capture");
    await expect(processRecord({ ...input, jobId: input.requestId, recoverCompleted: true })).rejects.toBeInstanceOf(RecordWaitingError);
    expect(fetchMock.mock.calls.map((call) => call[1].method)).toEqual(["GET", "GET"]);
  });

  it("recovers an accepted job when its POST acknowledgement was lost", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockRejectedValueOnce(new Error("connection interrupted after upload"))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "processing", retryAfterSeconds: 10 }));
    const { processRecord, RecordWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ failureStage: "request_transport" });
    await expect(processRecord({ ...input, recoverCompleted: true })).rejects.toBeInstanceOf(RecordWaitingError);
    expect(fetchMock.mock.calls[2][0]).toBe(`https://worker.example/capture/jobs/${input.requestId}`);
    expect(fetchMock.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(1);
  });

  it("resubmits a known retryable failed job instead of polling its failure forever", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "failed", error: "temporary", retryable: true }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "queued" }, 202));
    const { processRecord, RecordWaitingError } = await import("../src/services/capture");
    await expect(processRecord({ ...input, recoverCompleted: true })).rejects.toBeInstanceOf(RecordWaitingError);
    expect(fetchMock.mock.calls[3][1].body.get("request_id")).toBe(input.requestId);
  });

  it("downloads a ready result after restart without a second POST", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "ready" }))
      .mockResolvedValueOnce(json(payload));
    const { processRecord } = await import("../src/services/capture");
    expect(await processRecord({ ...input, jobId: input.requestId })).toEqual(payload);
    expect(fetchMock.mock.calls[2][0]).toBe(`https://worker.example/capture/result/${input.requestId}`);
    expect(fetchMock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("resubmits an expired job using the same idempotency key", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "queued" }, 202));
    const { processRecord, RecordWaitingError } = await import("../src/services/capture");
    await expect(processRecord({ ...input, jobId: input.requestId, recoverCompleted: true })).rejects.toBeInstanceOf(RecordWaitingError);
    expect(fetchMock.mock.calls[3][1].body.get("request_id")).toBe(input.requestId);
  });

  it("carries HTTP 429 Retry-After into the local retry scheduler", async () => {
    fetchMock.mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ detail: "busy" }, 429, { "Retry-After": "90" }));
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 90_000 });
  });

  it("preserves permanent failure classification for manual recovery", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({ jobId: input.requestId, status: "failed", error: "invalid video", retryable: false }));
    const { processRecord, RecordJobFailedError } = await import("../src/services/capture");
    const error = await processRecord({ ...input, jobId: input.requestId }).catch((error) => error);
    expect(error).toBeInstanceOf(RecordJobFailedError);
    expect(error.retryable).toBe(false);
  });

  it("falls back if async capability is stale during a rolling deploy", async () => {
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json(payload));
    const { processRecord } = await import("../src/services/capture");
    expect(await processRecord(input)).toEqual(payload);
    expect(fetchMock.mock.calls[2][0]).toBe("https://worker.example/capture/record");
  });

  it("keeps the polling timeout alive until the JSON body finishes", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }));
    fetchMock.mockImplementationOnce((_url, options) => Promise.resolve({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))))
    }));
    const { processRecord } = await import("../src/services/capture");
    const result = processRecord({ ...input, jobId: input.requestId }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({ failureStage: "result_recovery", retryable: true });
  });
});
