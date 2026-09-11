import * as FileSystem from "expo-file-system/legacy";

import type { FilmstripFrame, JumpRecord, JumpRecordDetail } from "../types/domain";
import type { RecordPayload } from "./capture";
import { createId } from "./analysis";

// Layout on disk:
//   records/index.json             — array of JumpRecord (light metadata)
//   records/<id>/clip.mp4          — the trimmed moment clip
//   records/<id>/skeleton.mp4      — skeleton-burned watermarked share version
//   records/<id>/detail.json       — metrics + series + filmstrip (heavy)
//   records/<id>/poster.jpg        — middle filmstrip frame, the list thumbnail
// New payloads use attempts/<attempt>/<write>/ under the record directory.
// Their URIs are published in the index only after every asset is written.

function recordsDirectory(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error("RiderLens records are unavailable on this device.");
  }
  return `${FileSystem.documentDirectory}riderlens/records/`;
}

const indexPath = () => `${recordsDirectory()}index.json`;
const pendingIndexPath = () => `${recordsDirectory()}index.pending.json`;
const recordDirectory = (id: string) => `${recordsDirectory()}${id}/`;
const deletionsPath = () => `${recordsDirectory()}deletions.json`;
const pendingDeletionsPath = () => `${recordsDirectory()}deletions.pending.json`;

const mediaOperations = new Map<string, Promise<void>>();
const deletedRecordIds = new Set<string>();

function serializeMedia<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const next = (mediaOperations.get(id) ?? Promise.resolve()).then(operation);
  const settled = next.then(() => undefined, () => undefined);
  mediaOperations.set(id, settled);
  void settled.then(() => {
    if (mediaOperations.get(id) === settled) mediaOperations.delete(id);
  });
  return next;
}

function assertRecordWritable(id: string): void {
  if (deletedRecordIds.has(id)) throw new Error("This record has been deleted.");
}

function detailPath(id: string, detailUri?: string): string {
  if (!detailUri) return `${recordDirectory(id)}detail.json`;
  // Only read a payload belonging to this record; the index is not an arbitrary
  // file-read capability. Reject encoded traversal as well as plain traversal.
  const decoded = decodeURIComponent(detailUri);
  if (!detailUri.startsWith(recordDirectory(id)) || !detailUri.endsWith("/detail.json") ||
      decoded.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Invalid record detail location.");
  }
  return detailUri;
}

async function ensureDirectory(path: string) {
  await FileSystem.makeDirectoryAsync(path, { intermediates: true });
}

export async function loadRecords(): Promise<JumpRecord[]> {
  // Expo's move replaces the destination on iOS by deleting it first. Recover
  // the completed staging file if termination happened in that small gap.
  let invalidSnapshot: unknown;
  for (const path of [pendingIndexPath(), indexPath()]) {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) continue;
    // A protected/unreadable index is not an empty library: hydration must stop
    // before the coordinator cancels its uploads as orphans or saves an empty index.
    const raw = await FileSystem.readAsStringAsync(path);
    try {
      const records = JSON.parse(raw) as JumpRecord[];
      if (!Array.isArray(records)) throw new Error("Invalid saved record index.");
      return records.map((record) =>
        record.status === "processing" && !record.analysisTransferId
          ? { ...record, status: "pending" as const, error: "Processing was interrupted. Retry when connected." }
          : record
      );
    } catch (error) {
      // A partial staging write must not hide the previous valid index.
      invalidSnapshot = error;
    }
  }
  if (invalidSnapshot) throw invalidSnapshot;
  return [];
}

let indexWrites: Promise<void> = Promise.resolve();

export function saveRecords(records: JumpRecord[]): Promise<void> {
  const snapshot = JSON.stringify(records);
  const write = indexWrites.then(async () => {
    await ensureDirectory(recordsDirectory());
    await FileSystem.writeAsStringAsync(pendingIndexPath(), snapshot);
    await FileSystem.moveAsync({ from: pendingIndexPath(), to: indexPath() });
  });
  // Callers still receive failures; a failed save must not poison later writes.
  indexWrites = write.catch(() => undefined);
  return write;
}

export type RecordDeletion = { id: string; sourceVideoUri: string; attemptId: string };
let deletionOperations: Promise<void> = Promise.resolve();

function serializeDeletions<T>(operation: () => Promise<T>): Promise<T> {
  const next = deletionOperations.then(operation);
  deletionOperations = next.then(() => undefined, () => undefined);
  return next;
}

async function readDeletions(): Promise<RecordDeletion[]> {
  let invalidSnapshot: unknown;
  for (const path of [pendingDeletionsPath(), deletionsPath()]) {
    if (!(await FileSystem.getInfoAsync(path)).exists) continue;
    // A filesystem error must not turn a deletion journal into an empty list.
    const raw = await FileSystem.readAsStringAsync(path);
    try {
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries) || !entries.every((entry) => entry &&
          typeof entry.id === "string" && typeof entry.sourceVideoUri === "string" && typeof entry.attemptId === "string")) {
        throw new Error("Invalid record deletion journal.");
      }
      return entries as RecordDeletion[];
    } catch (error) {
      invalidSnapshot = error;
    }
  }
  if (invalidSnapshot) throw invalidSnapshot;
  return [];
}

async function writeDeletions(entries: RecordDeletion[]): Promise<void> {
  await ensureDirectory(recordsDirectory());
  await FileSystem.writeAsStringAsync(pendingDeletionsPath(), JSON.stringify(entries));
  await FileSystem.moveAsync({ from: pendingDeletionsPath(), to: deletionsPath() });
}

/** Persist before removing the record index or cancelling its native transfer. */
export function beginRecordDeletion(intent: RecordDeletion): Promise<void> {
  const snapshot = { ...intent };
  return serializeDeletions(async () => {
    const entries = await readDeletions();
    const existing = entries.find((entry) => entry.id === snapshot.id);
    if (existing && (existing.attemptId !== snapshot.attemptId || existing.sourceVideoUri !== snapshot.sourceVideoUri)) {
      throw new Error("This record already has a different deletion in progress.");
    }
    if (!existing) await writeDeletions([...entries, snapshot]);
    deletedRecordIds.add(snapshot.id);
  });
}

export function loadRecordDeletions(): Promise<RecordDeletion[]> {
  return serializeDeletions(async () => {
    const entries = await readDeletions();
    entries.forEach((entry) => deletedRecordIds.add(entry.id));
    return entries;
  });
}

/** Only finish after native tasks are terminal and source/media cleanup succeeds. */
export function finishRecordDeletion(id: string): Promise<void> {
  return serializeDeletions(async () => {
    const entries = await readDeletions();
    await writeDeletions(entries.filter((entry) => entry.id !== id));
  });
}

export function createRecordId(): string {
  return createId("record");
}

/** Write the middle filmstrip frame (skeleton burned in) as the record's poster. */
async function writePoster(directory: string, filmstrip: FilmstripFrame[]): Promise<string | undefined> {
  const poster = filmstrip[Math.floor(filmstrip.length / 2)];
  const base64 = poster?.image.split(",", 2)[1];
  if (!base64) return undefined;
  const posterUri = `${directory}poster.jpg`;
  await FileSystem.writeAsStringAsync(posterUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return posterUri;
}

/** Persist a completed record payload: clip to disk, heavy detail to its own file. */
export async function persistRecordPayload(
  id: string,
  payload: RecordPayload,
  attemptId?: string
): Promise<{ clipUri: string; skeletonClipUri?: string; posterUri?: string; detailUri: string }> {
  return serializeMedia(id, async () => {
    assertRecordWritable(id);
    if (attemptId !== undefined && !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(attemptId)) {
      throw new Error("Invalid analysis attempt ID.");
    }
    const directory = attemptId
      ? `${recordDirectory(id)}attempts/${attemptId}/${createId("payload")}/`
      : recordDirectory(id);
    try {
      await ensureDirectory(directory);

      const clipUri = `${directory}clip.mp4`;
      const base64 = payload.clip.split(",", 2)[1] ?? "";
      await FileSystem.writeAsStringAsync(clipUri, base64, { encoding: FileSystem.EncodingType.Base64 });

      let skeletonClipUri: string | undefined;
      const skeletonBase64 = payload.skeletonClip?.split(",", 2)[1];
      if (skeletonBase64) {
        skeletonClipUri = `${directory}skeleton.mp4`;
        await FileSystem.writeAsStringAsync(skeletonClipUri, skeletonBase64, {
          encoding: FileSystem.EncodingType.Base64
        });
      }

      const detail: JumpRecordDetail = {
        series: payload.series,
        filmstrip: payload.filmstrip
      };
      const detailUri = `${directory}detail.json`;
      await FileSystem.writeAsStringAsync(detailUri, JSON.stringify(detail));

      const posterUri = await writePoster(directory, payload.filmstrip);
      assertRecordWritable(id);
      return { clipUri, skeletonClipUri, posterUri, detailUri };
    } catch (error) {
      // Never remove a legacy directory here: it may contain the last published
      // payload. A unique failed write cannot be referenced by a successful save.
      if (attemptId) await FileSystem.deleteAsync(directory, { idempotent: true }).catch(() => undefined);
      throw error;
    }
  });
}

/** Create the poster for a record processed before posters existed. */
export async function backfillPoster(id: string, detailUri?: string): Promise<string | undefined> {
  return serializeMedia(id, async () => {
    assertRecordWritable(id);
    const detail = await loadRecordDetail(id, detailUri);
    if (!detail || detail.filmstrip.length === 0) return undefined;
    const directory = detailPath(id, detailUri).replace(/detail\.json$/, "");
    await ensureDirectory(directory);
    const poster = await writePoster(directory, detail.filmstrip);
    assertRecordWritable(id);
    return poster;
  });
}

export async function loadRecordDetail(id: string, detailUri?: string): Promise<JumpRecordDetail | undefined> {
  try {
    const raw = await FileSystem.readAsStringAsync(detailPath(id, detailUri));
    return JSON.parse(raw) as JumpRecordDetail;
  } catch {
    return undefined;
  }
}

/** Remove an unpublished/superseded payload after its index reference is gone.
 * Legacy files share the record root, so they are retained until record deletion.
 */
export async function deleteRecordPayload(id: string, detailUri: string): Promise<void> {
  const path = detailPath(id, detailUri);
  const relative = path.slice(recordDirectory(id).length);
  if (relative === "detail.json") return;
  if (!/^attempts\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/payload-[A-Za-z0-9_-][A-Za-z0-9._-]*\/detail\.json$/.test(relative)) {
    throw new Error("Invalid record payload location.");
  }
  return serializeMedia(id, async () => {
    await FileSystem.deleteAsync(path.replace(/detail\.json$/, ""), { idempotent: true });
  });
}

export async function deleteRecordFiles(id: string): Promise<void> {
  // Fence late callbacks immediately, before waiting for an in-flight write.
  // IDs are never reused. After restart the removed record/index supplies the
  // durable fence; its old JS callbacks no longer exist.
  deletedRecordIds.add(id);
  return serializeMedia(id, async () => {
    await FileSystem.deleteAsync(recordDirectory(id), { idempotent: true });
  });
}
