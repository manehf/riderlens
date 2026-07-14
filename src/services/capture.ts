import type { CaptureEvent, FilmstripFrame, FlightEstimate, SeriesPoint } from "../types/domain";
import { getWorkerUrlCandidates } from "./analysisWorker";

// Reachability is decided by a fast /health pre-flight so a stale or unreachable
// worker IP fails in seconds instead of hanging until the big-upload timeouts below.
const LOCAL_HEALTH_TIMEOUT_MS = 4_000;
// A Fly machine stopped at zero can take around 20 seconds to boot. Give only
// that deployed fallback the longer allowance; a stale LAN IP should still fail
// quickly so the app can move on to Fly.
const FLY_COLD_START_HEALTH_TIMEOUT_MS = 30_000;
// Processing uploads the clip and runs the full pipeline; allow more, still
// bounded. Cloud processing of 4K phone footage can legitimately take minutes.
const RECORD_TIMEOUT_MS = 300_000;

class WorkerResponseError extends Error {}

export type RecordPayload = {
  clip: string; // data URL, video/mp4 base64
  skeletonClip: string | null; // skeleton-burned, watermarked share version
  window: { start: number; end: number };
  series: SeriesPoint[];
  filmstrip: FilmstripFrame[]; // full-body skeleton burned into every frame
  events: CaptureEvent[];
  flight: FlightEstimate | null; // null when events don't describe a flight
};

function videoFormPart(videoUri: string) {
  const name = videoUri.split("/").filter(Boolean).pop() ?? "clip.mp4";
  const lower = name.toLowerCase();
  const type = lower.endsWith(".mov") ? "video/quicktime" : "video/mp4";
  return { uri: videoUri, name: name.includes(".") ? name : "clip.mp4", type } as unknown as Blob;
}

/** Shared client key: identifies requests as coming from the RiderLens app so
 * the worker can refuse anonymous traffic. Not a real secret (it ships in the
 * binary) — real auth arrives with accounts. */
function workerHeaders(): Record<string, string> {
  const key = process.env.EXPO_PUBLIC_ANALYSIS_WORKER_KEY;
  return key ? { "x-riderlens-key": key } : {};
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, headers: { ...workerHeaders(), ...init.headers }, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readDetail(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return typeof payload.detail === "string" ? payload.detail : `Worker responded ${response.status}`;
  } catch {
    return `Worker responded ${response.status}`;
  }
}

async function workerReachable(workerUrl: string): Promise<boolean> {
  try {
    const timeoutMs = workerUrl.includes(".fly.dev") ? FLY_COLD_START_HEALTH_TIMEOUT_MS : LOCAL_HEALTH_TIMEOUT_MS;
    const response = await fetchWithTimeout(`${workerUrl}/health`, { method: "GET" }, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

// First healthy candidate wins (LAN worker before the deployed one). Cached
// briefly so a burst of requests doesn't probe /health repeatedly; a failed
// resolution is cached shorter so recovery isn't delayed.
let workerUrlCache: { url: string | null; checkedAt: number } | null = null;
const WORKER_URL_TTL_MS = 30_000;
const WORKER_URL_NEGATIVE_TTL_MS = 8_000;

async function resolveWorkerUrl(): Promise<string | null> {
  if (workerUrlCache) {
    const ttl = workerUrlCache.url ? WORKER_URL_TTL_MS : WORKER_URL_NEGATIVE_TTL_MS;
    if (Date.now() - workerUrlCache.checkedAt < ttl) return workerUrlCache.url;
  }
  for (const url of getWorkerUrlCandidates()) {
    if (await workerReachable(url)) {
      workerUrlCache = { url, checkedAt: Date.now() };
      return url;
    }
  }
  workerUrlCache = { url: null, checkedAt: Date.now() };
  return null;
}

export async function isAnalysisWorkerReachable(): Promise<boolean> {
  return Boolean(await resolveWorkerUrl());
}

export type ProcessRecordInput = {
  videoUri: string;
  uploadId?: string;
  startSeconds: number;
  endSeconds: number;
  events?: CaptureEvent[];
  rotateDegrees?: number;
};

/** Turn a confirmed window into the record. Throws with a readable message on failure
 * so the record can be kept as pending and retried later. */
export async function processRecord(input: ProcessRecordInput): Promise<RecordPayload> {
  if (getWorkerUrlCandidates().length === 0) {
    throw new Error("No analysis worker configured. Set EXPO_PUBLIC_ANALYSIS_WORKER_URL.");
  }
  const workerUrl = await resolveWorkerUrl();
  if (!workerUrl) {
    throw new Error("Could not reach the worker. The record is saved and will be retried.");
  }

  const formData = new FormData();
  formData.append("start_seconds", String(input.startSeconds));
  formData.append("end_seconds", String(input.endSeconds));
  if (input.events && input.events.length > 0) {
    formData.append("events_json", JSON.stringify(input.events));
  }
  if (input.rotateDegrees) {
    formData.append("rotate_degrees", String(input.rotateDegrees));
  }
  if (input.uploadId) {
    formData.append("upload_id", input.uploadId);
  } else {
    formData.append("video", videoFormPart(input.videoUri));
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RECORD_TIMEOUT_MS);
  try {
    const response = await fetch(`${workerUrl}/capture/record`, {
      method: "POST",
      headers: workerHeaders(),
      body: formData,
      signal: controller.signal
    });

    // The server-side upload expired; retry immediately with the full video.
    if (response.status === 410 && input.uploadId) {
      return processRecord({ ...input, uploadId: undefined });
    }
    if (!response.ok) {
      throw new WorkerResponseError(await readDetail(response));
    }

    // Keep the timeout alive through body transfer and JSON parsing. React
    // Native fetch can resolve after headers while a large body is still being
    // received; clearing it there left records in "processing" forever.
    return (await response.json()) as RecordPayload;
  } catch (error) {
    if (error instanceof WorkerResponseError) throw error;
    throw new Error(
      timedOut
        ? "The worker finished too slowly. The record is saved and will retry."
        : "Could not reach the worker. The record is saved and will be retried."
    );
  } finally {
    clearTimeout(timeout);
  }
}
