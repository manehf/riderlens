import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reachable: vi.fn(), report: vi.fn() }));
vi.mock("@sentry/react-native", () => ({ captureException: mocks.report }));
vi.mock("../src/services/analysisWorker", () => ({ getWorkerUrlCandidates: () => ["https://worker.example"] }));
vi.mock("../src/services/capture", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/capture")>(),
  isAnalysisWorkerReachable: mocks.reachable
}));
import { prewarmAnalysisWorker } from "../src/services/analysisPrewarm";
import { RecordForegroundWaitingError } from "../src/services/capture";

describe("optional worker warm-up", () => {
  beforeEach(() => vi.clearAllMocks());

  it("settles a picker/background interruption without an unhandled rejection or Sentry error", async () => {
    mocks.reachable.mockRejectedValue(new RecordForegroundWaitingError());
    await expect(prewarmAnalysisWorker()).resolves.toBeUndefined();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it.each([true, false])("does not block the picker when reachability is %s", async (reachable) => {
    mocks.reachable.mockResolvedValue(reachable);
    await expect(prewarmAnalysisWorker()).resolves.toBeUndefined();
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it("reports an unexpected warm-up defect with its own context", async () => {
    const error = new Error("invalid worker configuration");
    mocks.reachable.mockRejectedValue(error);
    await expect(prewarmAnalysisWorker()).resolves.toBeUndefined();
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith(error, {
      tags: { workflow: "analysis", failure_stage: "worker_prewarm" }
    });
  });
});
