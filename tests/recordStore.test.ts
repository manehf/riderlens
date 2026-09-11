import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JumpRecord } from "../src/types/domain";
import type { RecordPayload } from "../src/services/capture";

const fs = vi.hoisted(() => ({
  documentDirectory: "file:///documents/", makeDirectoryAsync: vi.fn(),
  writeAsStringAsync: vi.fn(), moveAsync: vi.fn(), getInfoAsync: vi.fn(), readAsStringAsync: vi.fn(),
  deleteAsync: vi.fn(), EncodingType: { Base64: "base64" }, sequence: 0
}));
vi.mock("expo-file-system/legacy", () => fs);
vi.mock("../src/services/analysis", () => ({ createId: (prefix: string) => `${prefix}-${++fs.sequence}` }));
const record = (id: string) => ({ id, status: "pending", analysisAttemptId: `attempt-${id}` } as JumpRecord);

describe("durable record index", () => {
  beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

  it("finishes each snapshot before writing the next, preserving call order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fs.writeAsStringAsync.mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const { saveRecords } = await import("../src/services/recordStore");
    const first = saveRecords([record("one")]);
    const second = saveRecords([record("two")]);
    await vi.waitFor(() => expect(fs.writeAsStringAsync).toHaveBeenCalledTimes(1));
    expect(fs.moveAsync).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(fs.writeAsStringAsync.mock.calls.map((call) => JSON.parse(call[1])[0].id)).toEqual(["one", "two"]);
    expect(fs.moveAsync).toHaveBeenCalledTimes(2);
    expect(fs.moveAsync.mock.invocationCallOrder[0]).toBeLessThan(fs.writeAsStringAsync.mock.invocationCallOrder[1]);
  });

  it("reports a failed write but still accepts the next save", async () => {
    fs.writeAsStringAsync.mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const { saveRecords } = await import("../src/services/recordStore");
    await expect(saveRecords([record("one")])).rejects.toThrow("disk full");
    await expect(saveRecords([record("two")])).resolves.toBeUndefined();
    expect(fs.moveAsync).toHaveBeenCalledTimes(1);
  });

  it("recovers a staged snapshot with its job ID and retry deadline after interruption", async () => {
    fs.getInfoAsync.mockResolvedValue({ exists: true });
    fs.readAsStringAsync.mockResolvedValue(JSON.stringify([{ ...record("one"), status: "processing", analysisJobId: "attempt-one", analysisNextRetryAt: 999, analysisRetryable: false }]));
    const { loadRecords } = await import("../src/services/recordStore");
    expect(await loadRecords()).toEqual([expect.objectContaining({ id: "one", status: "pending", analysisJobId: "attempt-one", analysisNextRetryAt: 999, analysisRetryable: false })]);
    expect(fs.readAsStringAsync.mock.calls[0][0]).toContain("index.pending.json");
  });

  it("falls back to the previous index if a staging write was interrupted", async () => {
    fs.getInfoAsync.mockResolvedValue({ exists: true });
    fs.readAsStringAsync.mockResolvedValueOnce("[{broken").mockResolvedValueOnce(JSON.stringify([record("previous")]));
    const { loadRecords } = await import("../src/services/recordStore");
    expect((await loadRecords())[0].id).toBe("previous");
  });

  it("preserves a native upload for reconciliation without claiming it was interrupted", async () => {
    fs.getInfoAsync.mockResolvedValue({ exists: true });
    const uploading = { ...record("one"), status: "processing", analysisTransferId: "transfer-one", analysisPhase: "uploading" };
    fs.readAsStringAsync.mockResolvedValue(JSON.stringify([uploading]));
    const { loadRecords } = await import("../src/services/recordStore");
    expect(await loadRecords()).toEqual([uploading]);
  });

  it("does not hydrate an unreadable or corrupt index as an empty library", async () => {
    fs.getInfoAsync.mockResolvedValue({ exists: true });
    fs.readAsStringAsync.mockRejectedValueOnce(new Error("file protection"));
    const { loadRecords } = await import("../src/services/recordStore");
    await expect(loadRecords()).rejects.toThrow("file protection");
    fs.readAsStringAsync.mockResolvedValue("[broken");
    await expect(loadRecords()).rejects.toThrow();
    fs.getInfoAsync.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(loadRecords()).rejects.toThrow("storage unavailable");
    expect(fs.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it("returns an empty library only when no index snapshot exists", async () => {
    fs.getInfoAsync.mockResolvedValue({ exists: false });
    const { loadRecords } = await import("../src/services/recordStore");
    await expect(loadRecords()).resolves.toEqual([]);
    expect(fs.readAsStringAsync).not.toHaveBeenCalled();
  });
});

const baseDirectory = "file:///documents/riderlens/records/";
const payload = (clip = "Y2xpcA=="): RecordPayload => ({
  clip: `data:video/mp4;base64,${clip}`, skeletonClip: "data:video/mp4;base64,c2tlbGV0b24=",
  window: { start: 0, end: 4 }, series: [], events: [], flight: null,
  filmstrip: [{ t: 2, image: "data:image/jpeg;base64,cG9zdGVy" }]
});

describe("record media and deletion recovery", () => {
  let files: Map<string, string>;
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    fs.sequence = 0;
    files = new Map();
    fs.makeDirectoryAsync.mockResolvedValue(undefined);
    fs.writeAsStringAsync.mockImplementation(async (path, contents) => { files.set(path, contents); });
    fs.getInfoAsync.mockImplementation(async (path) => ({ exists: files.has(path) }));
    fs.readAsStringAsync.mockImplementation(async (path) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return files.get(path);
    });
    fs.moveAsync.mockImplementation(async ({ from, to }) => {
      if (!files.has(from)) throw new Error("ENOENT");
      files.set(to, files.get(from)!);
      files.delete(from);
    });
    fs.deleteAsync.mockImplementation(async (path) => {
      for (const key of files.keys()) if (key === path || key.startsWith(path)) files.delete(key);
    });
  });

  it("isolates old, new and repeated attempt writes without overwriting published media", async () => {
    const { persistRecordPayload, loadRecordDetail } = await import("../src/services/recordStore");
    const old = await persistRecordPayload("one", payload("b2xk"), "attempt-old");
    const current = await persistRecordPayload("one", payload("bmV3"), "attempt-new");
    const late = await persistRecordPayload("one", payload("bGF0ZQ=="), "attempt-old");
    expect(new Set([old.clipUri, current.clipUri, late.clipUri]).size).toBe(3);
    expect(files.get(old.clipUri)).toBe("b2xk");
    expect(files.get(current.clipUri)).toBe("bmV3");
    expect(files.get(late.clipUri)).toBe("bGF0ZQ==");
    expect(current.clipUri).toContain("/attempts/attempt-new/");
    expect(await loadRecordDetail("one", current.detailUri)).toEqual({ series: [], filmstrip: payload().filmstrip });
    expect(files.get(current.posterUri!)).toBe("cG9zdGVy");
    expect(files.get(current.skeletonClipUri!)).toBe("c2tlbGV0b24=");
  });

  it("preserves the legacy read/write contract and backfills in the selected attempt directory", async () => {
    const { persistRecordPayload, loadRecordDetail, backfillPoster } = await import("../src/services/recordStore");
    const legacy = await persistRecordPayload("one", payload());
    expect(legacy.clipUri).toBe(`${baseDirectory}one/clip.mp4`);
    expect(await loadRecordDetail("one")).toEqual({ series: [], filmstrip: payload().filmstrip });
    const current = await persistRecordPayload("one", payload(), "new-attempt");
    files.delete(current.posterUri!);
    expect(await backfillPoster("one", current.detailUri)).toBe(current.posterUri);
    expect(files.get(current.posterUri!)).toBe("cG9zdGVy");
  });

  it("rejects a detail pointer into another record or through traversal", async () => {
    const { loadRecordDetail } = await import("../src/services/recordStore");
    await expect(loadRecordDetail("one", `${baseDirectory}two/detail.json`)).resolves.toBeUndefined();
    await expect(loadRecordDetail("one", `${baseDirectory}one/%2e%2e/two/detail.json`)).resolves.toBeUndefined();
    expect(fs.readAsStringAsync).not.toHaveBeenCalled();
  });

  it("cleans an incomplete attempt and propagates disk failure without touching the previous payload", async () => {
    const { persistRecordPayload } = await import("../src/services/recordStore");
    const old = await persistRecordPayload("one", payload(), "old");
    fs.writeAsStringAsync.mockRejectedValueOnce(new Error("disk full"));
    await expect(persistRecordPayload("one", payload(), "new")).rejects.toThrow("disk full");
    expect(files.has(old.clipUri)).toBe(true);
    expect(fs.deleteAsync.mock.calls[0][0]).toContain("/attempts/new/");
    await expect(persistRecordPayload("one", payload(), "new")).resolves.toHaveProperty("clipUri");
  });

  it("waits for in-flight writes before deletion and fences late payload/poster callbacks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fs.writeAsStringAsync.mockImplementationOnce(async (path, contents) => { await gate; files.set(path, contents); });
    const { persistRecordPayload, deleteRecordFiles, backfillPoster } = await import("../src/services/recordStore");
    const writing = persistRecordPayload("one", payload(), "attempt").catch((error) => error);
    await vi.waitFor(() => expect(fs.writeAsStringAsync).toHaveBeenCalledTimes(1));
    const deleting = deleteRecordFiles("one");
    expect(fs.deleteAsync).not.toHaveBeenCalled();
    release();
    expect(await writing).toBeInstanceOf(Error);
    await deleting;
    expect([...files.keys()].filter((path) => path.startsWith(`${baseDirectory}one/`))).toEqual([]);
    const writes = fs.writeAsStringAsync.mock.calls.length;
    await expect(persistRecordPayload("one", payload(), "late")).rejects.toThrow("deleted");
    await expect(backfillPoster("one")).rejects.toThrow("deleted");
    expect(fs.writeAsStringAsync).toHaveBeenCalledTimes(writes);
  });

  it("reports cleanup failure and permits deletion to retry without allowing new writers", async () => {
    const { deleteRecordFiles, persistRecordPayload } = await import("../src/services/recordStore");
    fs.deleteAsync.mockRejectedValueOnce(new Error("file protection"));
    await expect(deleteRecordFiles("one")).rejects.toThrow("file protection");
    await expect(persistRecordPayload("one", payload(), "late")).rejects.toThrow("deleted");
    await expect(deleteRecordFiles("one")).resolves.toBeUndefined();
  });

  it("cleans only the superseded payload, preserving current and legacy assets", async () => {
    const { persistRecordPayload, deleteRecordPayload } = await import("../src/services/recordStore");
    const legacy = await persistRecordPayload("one", payload());
    const old = await persistRecordPayload("one", payload(), "old");
    const current = await persistRecordPayload("one", payload(), "current");
    await deleteRecordPayload("one", old.detailUri);
    expect(files.has(old.clipUri)).toBe(false);
    expect(files.has(old.detailUri)).toBe(false);
    expect(files.has(current.clipUri)).toBe(true);
    expect(files.has(legacy.clipUri)).toBe(true);
    await deleteRecordPayload("one", legacy.detailUri);
    expect(files.has(legacy.clipUri)).toBe(true);
    expect(fs.deleteAsync).toHaveBeenCalledTimes(1);
  });

  it("rejects payload cleanup outside the exact per-write directory layout", async () => {
    const { deleteRecordPayload } = await import("../src/services/recordStore");
    for (const path of [
      `${baseDirectory}two/attempts/current/payload-1/detail.json`,
      `${baseDirectory}one/attempts/current/detail.json`,
      `${baseDirectory}one/attempts/current/../detail.json`,
      `${baseDirectory}one/attempts/current/%2e%2e/detail.json`,
      `${baseDirectory}one/attempts/current/unexpected/detail.json`
    ]) await expect(deleteRecordPayload("one", path)).rejects.toThrow("Invalid record");
    expect(fs.deleteAsync).not.toHaveBeenCalled();
  });

  it("serializes payload cleanup with writes and reports cleanup disk failures", async () => {
    const { persistRecordPayload, deleteRecordPayload } = await import("../src/services/recordStore");
    const old = await persistRecordPayload("one", payload(), "old");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fs.writeAsStringAsync.mockImplementationOnce(async (path, contents) => { await gate; files.set(path, contents); });
    const writing = persistRecordPayload("one", payload(), "current");
    await vi.waitFor(() => expect(fs.writeAsStringAsync).toHaveBeenCalledTimes(5));
    const cleaning = deleteRecordPayload("one", old.detailUri);
    expect(fs.deleteAsync).not.toHaveBeenCalled();
    release();
    const current = await writing;
    await cleaning;
    expect(files.has(current.clipUri)).toBe(true);
    fs.deleteAsync.mockRejectedValueOnce(new Error("file protection"));
    await expect(deleteRecordPayload("one", current.detailUri)).rejects.toThrow("file protection");
    expect(files.has(current.clipUri)).toBe(true);
  });

  const intent = (id: string) => ({ id, sourceVideoUri: `file:///source-${id}.mp4`, attemptId: `attempt-${id}` });

  it("serializes deletion intent mutations without dropping another record", async () => {
    const { beginRecordDeletion, loadRecordDeletions, finishRecordDeletion } = await import("../src/services/recordStore");
    await Promise.all([beginRecordDeletion(intent("one")), beginRecordDeletion(intent("two"))]);
    expect(await loadRecordDeletions()).toEqual([intent("one"), intent("two")]);
    await finishRecordDeletion("one");
    expect(await loadRecordDeletions()).toEqual([intent("two")]);
    expect(files.has(`${baseDirectory}deletions.pending.json`)).toBe(false);
  });

  it("restores deletion fences after restart and interrupted index-removal", async () => {
    files.set(`${baseDirectory}deletions.pending.json`, JSON.stringify([intent("one")]));
    const { loadRecordDeletions, persistRecordPayload } = await import("../src/services/recordStore");
    expect(await loadRecordDeletions()).toEqual([intent("one")]);
    await expect(persistRecordPayload("one", payload(), "attempt-one")).rejects.toThrow("deleted");
    expect(fs.makeDirectoryAsync).not.toHaveBeenCalled();
  });

  it("recovers a valid older deletion snapshot after a partial staging write", async () => {
    files.set(`${baseDirectory}deletions.pending.json`, "[broken");
    files.set(`${baseDirectory}deletions.json`, JSON.stringify([intent("one")]));
    const { loadRecordDeletions } = await import("../src/services/recordStore");
    expect(await loadRecordDeletions()).toEqual([intent("one")]);
  });

  it("does not treat journal corruption or read errors as an empty deletion list", async () => {
    files.set(`${baseDirectory}deletions.json`, "[broken");
    const { loadRecordDeletions } = await import("../src/services/recordStore");
    await expect(loadRecordDeletions()).rejects.toThrow();
    fs.readAsStringAsync.mockRejectedValueOnce(new Error("file protection"));
    await expect(loadRecordDeletions()).rejects.toThrow("file protection");
  });

  it("propagates intent write failure and allows a later retry", async () => {
    const { beginRecordDeletion, loadRecordDeletions } = await import("../src/services/recordStore");
    fs.writeAsStringAsync.mockRejectedValueOnce(new Error("disk full"));
    await expect(beginRecordDeletion(intent("one"))).rejects.toThrow("disk full");
    await beginRecordDeletion(intent("one"));
    expect(await loadRecordDeletions()).toEqual([intent("one")]);
  });

  it("keeps a pending intent until finishing it is durable", async () => {
    const { beginRecordDeletion, finishRecordDeletion, loadRecordDeletions } = await import("../src/services/recordStore");
    await beginRecordDeletion(intent("one"));
    fs.writeAsStringAsync.mockRejectedValueOnce(new Error("disk full"));
    await expect(finishRecordDeletion("one")).rejects.toThrow("disk full");
    expect(await loadRecordDeletions()).toEqual([intent("one")]);
    await expect(beginRecordDeletion({ ...intent("one"), attemptId: "different" })).rejects.toThrow("different deletion");
  });
});
