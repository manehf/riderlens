import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferSnapshot } from "../src/services/analysisTransport.types";

const native = vi.hoisted(() => ({ reconcile: vi.fn(), ensureUpload: vi.fn(), cancel: vi.fn(), acknowledge: vi.fn(), enabled: vi.fn(() => true), watch: vi.fn((_abort: () => void) => () => undefined) }));
vi.mock("../src/services/analysisTransport", () => ({ getAnalysisTransport: () => native, nativeAnalysisSubmissionsEnabled: native.enabled, watchAnalysisBackground: native.watch }));
vi.mock("../src/services/analysisWorker", () => ({ getWorkerUrlCandidates: () => ["https://worker.example"] }));
const input = { videoUri: "file:///clip.mov", requestId: "attempt-123", startSeconds: 0, endSeconds: 4 };
const snapshot = (patch: Partial<TransferSnapshot> = {}): TransferSnapshot => ({
  attemptId: input.requestId, transferId: "transfer-1", state: "running", bytesSent: 5, bytesExpected: 20, createdAt: 1, ...patch
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("durable iOS submission", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules(); vi.resetAllMocks();
    native.reconcile.mockResolvedValue([]);
    native.enabled.mockReturnValue(true);
    native.watch.mockImplementation(() => () => undefined);
    native.ensureUpload.mockResolvedValue(snapshot({ state: "preparing" }));
    fetchMock = vi.fn().mockResolvedValue(response({ captureJobsEnabled: true }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("returns after native scheduling without a POST fetch or five-minute JS timer", async () => {
    vi.useFakeTimers();
    const { processRecord, RecordTransferWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toBeInstanceOf(RecordTransferWaitingError);
    expect(native.ensureUpload).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: input.requestId, sourceUri: input.videoUri, url: "https://worker.example/capture/jobs",
      fields: { request_id: input.requestId, start_seconds: "0", end_seconds: "4" }
    }));
    expect(fetchMock.mock.calls.map((call) => call[1].method)).toEqual(["GET"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["preparing", "running", "cancelling"] as const)("reattaches %s before health/recovery and never submits", async (state) => {
    native.reconcile.mockResolvedValue([snapshot({ state })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord({ ...input, recoverCompleted: true })).rejects.toMatchObject({ transfer: { state } });
    expect(fetchMock).not.toHaveBeenCalled(); expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("consumes an accepted receipt offline, preserving it for caller persistence/ACK", async () => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", status: 202, body: JSON.stringify({ jobId: input.requestId, status: "queued" }) })]);
    const { processRecord, RecordWaitingError } = await import("../src/services/capture");
    const error = await processRecord(input).catch((error) => error);
    expect(error).toBeInstanceOf(RecordWaitingError);
    expect(error).toMatchObject({ jobId: input.requestId, transfer: { transferId: "transfer-1" } });
    expect(native.acknowledge).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists ready acceptance before attempting the large result download", async () => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", status: 202, body: JSON.stringify({ jobId: input.requestId, status: "ready" }) })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ jobId: input.requestId, retryAfterMs: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["not-json", "null", JSON.stringify({ jobId: "another-attempt", status: "queued" })])("rejects an invalid receipt without acknowledging it: %s", async (body) => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", status: 202, body })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ retryable: true, failureStage: "worker_response" });
    expect(native.acknowledge).not.toHaveBeenCalled(); expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("retains Retry-After on a native 429 response", async () => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", status: 429, retryAfter: "90", body: JSON.stringify({ detail: "busy" }) })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ status: 429, retryAfterMs: 90_000, retryable: true });
  });

  it("reports a native upload timeout without blaming analysis processing or exposing the receipt body", async () => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", errorDomain: "NSURLErrorDomain", errorCode: -1001, body: "private acknowledgement" })]);
    const { processRecord } = await import("../src/services/capture");
    const error = await processRecord(input).catch((error) => error);
    expect(error).toMatchObject({ failureStage: "upload_timeout", retryable: true });
    expect(error.message).not.toContain("worker");
    expect(JSON.stringify(error)).not.toContain("private acknowledgement");
  });

  it("does not turn a permanent native rejection into a lookup/reupload loop", async () => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", status: 422, body: JSON.stringify({ detail: "invalid clip" }) })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ status: 422, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("classifies an expired upload ID for a later source retry after ACK", async () => {
    native.reconcile.mockResolvedValue([snapshot({ state: "terminal", status: 410 })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord({ ...input, uploadId: "expired" })).rejects.toMatchObject({ legacySubmission: false, retryAfterMs: 0 });
    expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("persists stale-capability fallback and uses the old endpoint on the next attempt", async () => {
    native.reconcile.mockResolvedValueOnce([snapshot({ state: "terminal", status: 405 })]);
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toMatchObject({ legacySubmission: true });
    fetchMock.mockResolvedValueOnce(response({ captureJobsEnabled: true })).mockResolvedValueOnce(response({ clip: "data" }));
    expect(await processRecord({ ...input, legacySubmission: true })).toEqual({ clip: "data" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://worker.example/capture/record");
    expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("checks job and result before reuploading an unknown outcome after ACK", async () => {
    fetchMock.mockResolvedValueOnce(response({ captureJobsEnabled: true }))
      .mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({}, 404));
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord({ ...input, recoverCompleted: true })).rejects.toMatchObject({ transfer: { state: "preparing" } });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://worker.example/health", `https://worker.example/capture/jobs/${input.requestId}`, `https://worker.example/capture/result/${input.requestId}`
    ]);
    expect(native.ensureUpload).toHaveBeenCalledOnce();
  });

  it("never treats a lookup connection error as a 404", async () => {
    fetchMock.mockResolvedValueOnce(response({ captureJobsEnabled: true })).mockRejectedValueOnce(new Error("offline"));
    const { processRecord } = await import("../src/services/capture");
    await expect(processRecord({ ...input, recoverCompleted: true })).rejects.toMatchObject({ failureStage: "result_recovery" });
    expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("waits for the global upload slot without creating a failure", async () => {
    native.ensureUpload.mockRejectedValue(Object.assign(new Error("busy"), { code: "E_TRANSFER_BUSY" }));
    const { processRecord, RecordTransferWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toBeInstanceOf(RecordTransferWaitingError);
  });

  it("does not admit a new upload if the app left foreground during recovery", async () => {
    const { processRecord, RecordTransferWaitingError } = await import("../src/services/capture");
    await expect(processRecord({ ...input, canSubmit: () => false })).rejects.toBeInstanceOf(RecordTransferWaitingError);
    expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("drains an old upload before using the build-time foreground fallback", async () => {
    native.enabled.mockReturnValue(false);
    native.reconcile.mockResolvedValue([snapshot({ attemptId: "old-attempt" })]);
    const { processRecord, RecordTransferWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toBeInstanceOf(RecordTransferWaitingError);
    expect(native.ensureUpload).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("defers a polling read cancelled on background instead of reporting analysis failure", async () => {
    let abortRead: (() => void) | undefined;
    native.watch.mockImplementation((abort) => { abortRead = abort; return () => undefined; });
    fetchMock.mockResolvedValueOnce(response({ captureJobsEnabled: true })).mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        abortRead!();
      });
    });
    const { processRecord, RecordForegroundWaitingError } = await import("../src/services/capture");
    await expect(processRecord({ ...input, jobId: input.requestId })).rejects.toBeInstanceOf(RecordForegroundWaitingError);
    expect(native.ensureUpload).not.toHaveBeenCalled();
  });

  it("defers a health check cancelled by background without claiming the worker is unreachable", async () => {
    native.watch.mockImplementation((abort) => { abort(); return () => undefined; });
    fetchMock.mockRejectedValue(new Error("aborted"));
    const { processRecord, RecordForegroundWaitingError } = await import("../src/services/capture");
    await expect(processRecord(input)).rejects.toBeInstanceOf(RecordForegroundWaitingError);
    expect(native.ensureUpload).not.toHaveBeenCalled();
  });
});
