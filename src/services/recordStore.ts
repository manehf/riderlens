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

function recordsDirectory(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error("RiderLens records are unavailable on this device.");
  }
  return `${FileSystem.documentDirectory}riderlens/records/`;
}

const indexPath = () => `${recordsDirectory()}index.json`;
const recordDirectory = (id: string) => `${recordsDirectory()}${id}/`;

async function ensureDirectory(path: string) {
  await FileSystem.makeDirectoryAsync(path, { intermediates: true });
}

export async function loadRecords(): Promise<JumpRecord[]> {
  try {
    const info = await FileSystem.getInfoAsync(indexPath());
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(indexPath());
    const records = JSON.parse(raw) as JumpRecord[];
    // A record that died mid-processing (app closed) has no request to resolve it.
    return records.map((record) =>
      record.status === "processing"
        ? { ...record, status: "pending" as const, error: "Processing was interrupted. Retry when connected." }
        : record
    );
  } catch {
    return [];
  }
}

export async function saveRecords(records: JumpRecord[]): Promise<void> {
  await ensureDirectory(recordsDirectory());
  await FileSystem.writeAsStringAsync(indexPath(), JSON.stringify(records));
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
  payload: RecordPayload
): Promise<{ clipUri: string; skeletonClipUri?: string; posterUri?: string }> {
  const directory = recordDirectory(id);
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
  await FileSystem.writeAsStringAsync(`${directory}detail.json`, JSON.stringify(detail));

  const posterUri = await writePoster(directory, payload.filmstrip);
  return { clipUri, skeletonClipUri, posterUri };
}

/** Create the poster for a record processed before posters existed. */
export async function backfillPoster(id: string): Promise<string | undefined> {
  const detail = await loadRecordDetail(id);
  if (!detail || detail.filmstrip.length === 0) return undefined;
  const directory = recordDirectory(id);
  await ensureDirectory(directory);
  return writePoster(directory, detail.filmstrip);
}

export async function loadRecordDetail(id: string): Promise<JumpRecordDetail | undefined> {
  try {
    const raw = await FileSystem.readAsStringAsync(`${recordDirectory(id)}detail.json`);
    return JSON.parse(raw) as JumpRecordDetail;
  } catch {
    return undefined;
  }
}

export async function deleteRecordFiles(id: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(recordDirectory(id), { idempotent: true });
  } catch {
    // Directory may never have been created for pending records.
  }
}
