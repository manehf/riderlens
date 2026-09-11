import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  state: "active",
  listeners: new Set<(state: string) => void>()
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() { return lifecycle.state; },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      lifecycle.listeners.add(listener);
      return { remove: () => lifecycle.listeners.delete(listener) };
    }
  }
}));
// Exercise the adapter Metro selects on Android, rather than the generic fallback.
vi.mock("../src/services/analysisTransport", () => import("../src/services/analysisTransport.android"));
vi.mock("../src/services/analysisWorker", () => ({ getWorkerUrlCandidates: () => ["https://worker.example"] }));

const input = { videoUri: "file:///clip.mp4", requestId: "analysis-android", jobId: "analysis-android", startSeconds: 0, endSeconds: 4 };
const payload = { clip: "data:video/mp4;base64,eA==", skeletonClip: null, window: { start: 0, end: 4 }, series: [], filmstrip: [], events: [], flight: null };
const json = (value: unknown) => new Response(JSON.stringify(value));
function changeState(state: string) {
  lifecycle.state = state;
  for (const listener of lifecycle.listeners) listener(state);
}

describe("Android analysis reads across screen lock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    lifecycle.state = "active";
    lifecycle.listeners.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(["poll", "result"])("defers interrupted %s and recovers the same job without another upload", async (stage) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true }));
    if (stage === "result") fetchMock.mockResolvedValueOnce(json({ jobId: input.jobId, status: "ready" }));
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        // Native error delivery can reach JS only after the app becomes active.
        changeState("active");
        reject(new TypeError("Network request failed"));
      });
      changeState("background");
    }));
    const { processRecord, RecordForegroundWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toBeInstanceOf(RecordForegroundWaitingError);
    expect(lifecycle.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    fetchMock.mockResolvedValueOnce(json({ jobId: input.jobId, status: "ready" }))
      .mockResolvedValueOnce(json(payload));
    expect(await processRecord(input)).toEqual(payload);
    expect(fetchMock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
    expect(fetchMock.mock.calls.filter((call) => call[0].includes("/capture/jobs/"))
      .every((call) => call[0].endsWith(input.jobId))).toBe(true);
    expect(lifecycle.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an actual foreground network failure visible and retryable", async () => {
    const failure = new TypeError("Network request failed");
    fetchMock.mockResolvedValueOnce(json({ captureJobsEnabled: true })).mockRejectedValueOnce(failure);
    const { processRecord, RecordForegroundWaitingError } = await import("../src/services/capture");
    const error = await processRecord(input).catch((error) => error);
    expect(error).not.toBeInstanceOf(RecordForegroundWaitingError);
    expect(error).toMatchObject({ failureStage: "result_recovery", retryable: true, cause: failure });
    expect(lifecycle.listeners.size).toBe(0);
  });

  it("defers an already-background health check instead of declaring the worker unreachable", async () => {
    lifecycle.state = "background";
    fetchMock.mockImplementation((_url, init) => {
      expect(init.signal.aborted).toBe(true);
      return Promise.reject(new Error("aborted"));
    });
    const { processRecord, RecordForegroundWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toBeInstanceOf(RecordForegroundWaitingError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lifecycle.listeners.size).toBe(0);
  });
});
