import { describe, expect, it, vi } from "vitest";
import { consumeTransferReceipt, reconcileAnalysisTransfers, transferDiagnostics } from "../src/services/analysisCoordinator";
import { SerialAnalysisQueue } from "../src/services/analysisRetry";
import type { JumpRecord } from "../src/types/domain";
import type { AnalysisTransport, TransferSnapshot } from "../src/services/analysisTransport.types";

const task = (attemptId: string, state: TransferSnapshot["state"] = "running"): TransferSnapshot => ({
  attemptId, transferId: `transfer-${attemptId}`, state, bytesSent: 1, bytesExpected: 10, createdAt: 1
});
const record = (attempt: string) => ({ id: "record", analysisAttemptId: attempt, status: "processing" } as JumpRecord);
function transport(snapshots: TransferSnapshot[]): AnalysisTransport {
  return { reconcile: vi.fn(async () => snapshots), cancel: vi.fn(async () => task("old", "cancelling")),
    acknowledge: vi.fn(async () => undefined), ensureUpload: vi.fn(), resume: vi.fn(async () => task("current")) };
}

describe("analysis transfer ownership", () => {
  it("resumes preparation only after confirming and persisting current ownership", async () => {
    const native = transport([task("current", "preparing")]);
    const save = vi.fn(async () => undefined);
    await reconcileAnalysisTransfers(native, () => [record("current")], save);
    expect(native.resume).toHaveBeenCalledWith("transfer-current");
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(native.resume).mock.invocationCallOrder[0]);
  });

  it("cancels a removed preparation instead of starting it during enumeration", async () => {
    const native = transport([task("old", "preparing")]);
    await reconcileAnalysisTransfers(native, () => [], async () => undefined);
    expect(native.resume).not.toHaveBeenCalled(); expect(native.cancel).toHaveBeenCalledWith("transfer-old");
  });

  it("rechecks ownership after the async persistence boundary", async () => {
    const native = transport([task("current", "preparing")]);
    let records = [record("current")];
    await reconcileAnalysisTransfers(native, () => records, async () => { records = []; });
    expect(native.resume).not.toHaveBeenCalled(); expect(native.cancel).toHaveBeenCalledWith("transfer-current");
  });

  it("leaves preparation paused if the app went to background", async () => {
    const native = transport([task("current", "preparing")]);
    await reconcileAnalysisTransfers(native, () => [record("current")], async () => undefined, () => false);
    expect(native.resume).not.toHaveBeenCalled(); expect(native.cancel).not.toHaveBeenCalled();
  });
  it("reattaches uploading records and waits for orphan cancellation before cleanup", async () => {
    const native = transport([task("current"), task("old")]);
    const save = vi.fn(async () => undefined);
    const result = await reconcileAnalysisTransfers(native, () => [record("current")], save);
    expect(result.map((item) => item.state)).toEqual(["running", "cancelling"]);
    expect(native.cancel).toHaveBeenCalledWith("transfer-old");
    expect(native.acknowledge).not.toHaveBeenCalled();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(native.cancel).mock.invocationCallOrder[0]);
  });

  it("cleans orphan receipts but leaves current receipts for durable classification", async () => {
    const native = transport([task("current", "terminal"), task("deleted", "terminal")]);
    const result = await reconcileAnalysisTransfers(native, () => [record("current")], async () => undefined);
    expect(result).toEqual([task("current", "terminal")]);
    expect(native.acknowledge).toHaveBeenCalledExactlyOnceWith("transfer-deleted");
  });

  it("does not cancel or acknowledge if changed ownership cannot be persisted", async () => {
    const native = transport([task("old")]);
    await expect(reconcileAnalysisTransfers(native, () => [], async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(native.cancel).not.toHaveBeenCalled(); expect(native.acknowledge).not.toHaveBeenCalled();
  });

  it("does not lose a terminal receipt when record persistence fails", async () => {
    const native = transport([]);
    await expect(consumeTransferReceipt(native, task("current", "terminal"), async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(native.acknowledge).not.toHaveBeenCalled();
    const persist = vi.fn(async () => undefined);
    await consumeTransferReceipt(native, task("current", "terminal"), persist);
    expect(persist.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(native.acknowledge).mock.invocationCallOrder[0]);
  });

  it("does not ACK a live task merely because progress was persisted", async () => {
    const native = transport([]);
    await consumeTransferReceipt(native, task("current"), async () => undefined);
    expect(native.acknowledge).not.toHaveBeenCalled();
  });

  it("lets another job poll while the native upload remains active", async () => {
    const queue = new SerialAnalysisQueue();
    const native = transport([task("upload")]);
    const poll = vi.fn(async () => undefined);
    await Promise.all([queue.enqueue("upload", async () => { await native.reconcile(); }), queue.enqueue("job", poll)]);
    expect(poll).toHaveBeenCalledOnce();
    expect(native.cancel).not.toHaveBeenCalled();
  });

  it("does not include bodies or error messages in diagnostics", () => {
    const safe = transferDiagnostics({ ...task("current"), body: "private response", errorMessage: "file:///private/video.mov" });
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(safe.requestId).toBe("current");
  });
});
