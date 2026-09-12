import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/analysisWorker", () => ({ getWorkerUrlCandidates: () => ["https://worker.example"] }));

const input = { videoUri: "file:///clip.mp4", requestId: "analysis-result-test", jobId: "analysis-result-test", startSeconds: 0, endSeconds: 4 };
const payload = { clip: "data:video/mp4;base64,eA==", skeletonClip: null, window: { start: 0, end: 4 }, series: [], filmstrip: [], events: [], flight: null };
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
const ready = () => json({ jobId: input.jobId, status: "ready" });

function delayed<T>(signal: AbortSignal, value: T, delay?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = delay === undefined ? undefined : setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

describe("completed analysis download deadlines", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValueOnce(json({ captureJobsEnabled: true }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(["headers", "body"])("allows slow result %s with a separate deadline after a slow status check", async (stage) => {
    let statusSignal: AbortSignal;
    let resultSignal: AbortSignal;
    const onPhase = vi.fn();
    fetchMock.mockImplementationOnce((_url, init) => {
      statusSignal = init.signal;
      return delayed(init.signal, ready(), 25_000);
    }).mockImplementationOnce((_url, init) => {
      resultSignal = init.signal;
      return stage === "headers" ? delayed(init.signal, json(payload), 75_000)
        : Promise.resolve({ ok: true, status: 200, json: () => delayed(init.signal, payload, 75_000) });
    });
    const { processRecord } = await import("../src/services/capture");
    const result = processRecord({ ...input, onPhase }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await result).toEqual(payload);
    expect(statusSignal!.aborted).toBe(false);
    expect(resultSignal!.aborted).toBe(false);
    expect(onPhase).toHaveBeenCalledExactlyOnceWith("downloading");
    expect(fetchMock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("times out stalled result %s and later recovers the same job without reuploading", async (stage) => {
    fetchMock.mockResolvedValueOnce(ready()).mockImplementationOnce((_url, init) =>
      stage === "headers" ? delayed(init.signal, json(payload))
        : Promise.resolve({ ok: true, status: 200, json: () => delayed(init.signal, payload) }));
    const { processRecord, RecordReadTimeoutError } = await import("../src/services/capture");
    const result = processRecord(input).catch((error) => error);
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeInstanceOf(RecordReadTimeoutError);
    expect(await result).toMatchObject({
      failureStage: "result_timeout", operation: "result", timeoutMs: 120_000, elapsedMs: 120_000, retryable: true
    });
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(ready()).mockResolvedValueOnce(json(payload));
    expect(await processRecord(input)).toEqual(payload);
    expect(fetchMock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
    expect(fetchMock.mock.calls.filter((call) => call[0].includes("/capture/"))
      .every((call) => call[0].endsWith(input.jobId))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps status checks bounded at 30 seconds through body transfer", async () => {
    fetchMock.mockImplementationOnce((_url, init) => Promise.resolve({
      ok: true, status: 200, json: () => delayed(init.signal, { jobId: input.jobId, status: "ready" })
    }));
    const { processRecord } = await import("../src/services/capture");
    const result = processRecord(input).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({
      failureStage: "result_recovery", operation: "status", timeoutMs: 30_000, elapsedMs: 30_000, retryable: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("does not mislabel an actual network failure during %s as a timeout", async (stage) => {
    const failure = new TypeError("Network request failed");
    fetchMock.mockResolvedValueOnce(ready());
    if (stage === "headers") fetchMock.mockRejectedValueOnce(failure);
    else fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(failure) });
    const { processRecord, RecordReadTimeoutError } = await import("../src/services/capture");
    const error = await processRecord(input).catch((error) => error);
    expect(error).not.toBeInstanceOf(RecordReadTimeoutError);
    expect(error).toMatchObject({ failureStage: stage === "headers" ? "result_recovery" : "response_download", cause: failure, retryable: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not attribute an external abort to our deadline", async () => {
    const failure = new DOMException("Aborted", "AbortError");
    fetchMock.mockResolvedValueOnce(ready()).mockRejectedValueOnce(failure);
    const { processRecord, RecordReadTimeoutError } = await import("../src/services/capture");
    const error = await processRecord(input).catch((error) => error);
    expect(error).not.toBeInstanceOf(RecordReadTimeoutError);
    expect(error).toMatchObject({ failureStage: "result_recovery", cause: failure, retryable: true });
  });

  it.each([401, 429, 503])("preserves result HTTP %s classification and retry hints", async (status) => {
    fetchMock.mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(json({ detail: "unavailable" }, status, { "Retry-After": "90" }));
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({
      failureStage: "worker_response", status, retryable: status !== 401, retryAfterMs: 90_000
    });
  });

  it("recovers a slow cached result from a legacy worker without submitting again", async () => {
    fetchMock.mockReset().mockResolvedValueOnce(json({ status: "ok" }))
      .mockImplementationOnce((_url, init) => delayed(init.signal, json(payload), 60_000));
    const { processRecord } = await import("../src/services/capture");
    const result = processRecord({ ...input, jobId: undefined, recoverCompleted: true }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toEqual(payload);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://worker.example/capture/result/${input.requestId}`);
    expect(fetchMock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("does not treat an aborted health response body as a healthy legacy worker", async () => {
    fetchMock.mockReset().mockImplementationOnce((_url, init) => Promise.resolve({
      ok: true, status: 200, json: () => delayed(init.signal, {})
    }));
    const { isAnalysisWorkerReachable } = await import("../src/services/capture");
    const result = isAnalysisWorkerReachable();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
