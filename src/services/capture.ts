import type { CaptureEvent, FilmstripFrame, FlightEstimate, SeriesPoint } from "../types/domain";
import { getAnalysisWorkerUrl } from "./analysisWorker";

// Reachability is decided by a fast /health pre-flight so a stale or unreachable
// worker IP fails in seconds instead of hanging until the big-upload timeouts below.
const HEALTH_TIMEOUT_MS = 4_000;
// Upload + contact sheet + AI window-finding legitimately takes 15-25s when connected.
const ANALYZE_TIMEOUT_MS = 60_000;
// Processing uploads the clip and runs the full pipeline; allow more, still bounded.
const RECORD_TIMEOUT_MS = 180_000;

export type WindowProposal = {
  uploadId: string;
  durationSeconds: number;
  aiAvailable: boolean;
  window: { start: number; end: number } | null;
  events: CaptureEvent[];
  eventType?: string;
  summary?: string;
};

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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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
    const response = await fetchWithTimeout(`${workerUrl}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

export async function isAnalysisWorkerReachable(): Promise<boolean> {
  const workerUrl = getAnalysisWorkerUrl();
  return workerUrl ? workerReachable(workerUrl) : false;
}

/** Upload the clip and get an AI-proposed window. Returns undefined when the worker
 * is unreachable, slow, or has no AI credentials — the caller falls back to manual trim. */
export async function proposeWindow(videoUri: string): Promise<WindowProposal | undefined> {
  const workerUrl = getAnalysisWorkerUrl();
  if (!workerUrl) return undefined;
  if (!(await workerReachable(workerUrl))) return undefined;

  const formData = new FormData();
  formData.append("video", videoFormPart(videoUri));

  try {
    const response = await fetchWithTimeout(
      `${workerUrl}/capture/analyze`,
      { method: "POST", body: formData },
      ANALYZE_TIMEOUT_MS
    );
    if (!response.ok) return undefined;
    return (await response.json()) as WindowProposal;
  } catch {
    return undefined;
  }
}

export type ProcessRecordInput = {
  videoUri: string;
  uploadId?: string;
  startSeconds: number;
  endSeconds: number;
  events?: CaptureEvent[];
};

/** Turn a confirmed window into the record. Throws with a readable message on failure
 * so the record can be kept as pending and retried later. */
export async function processRecord(input: ProcessRecordInput): Promise<RecordPayload> {
  const workerUrl = getAnalysisWorkerUrl();
  if (!workerUrl) {
    throw new Error("No analysis worker configured. Set EXPO_PUBLIC_ANALYSIS_WORKER_URL.");
  }
  if (!(await workerReachable(workerUrl))) {
    throw new Error("Could not reach the worker. The record is saved and will be retried.");
  }

  const formData = new FormData();
  formData.append("start_seconds", String(input.startSeconds));
  formData.append("end_seconds", String(input.endSeconds));
  if (input.events && input.events.length > 0) {
    formData.append("events_json", JSON.stringify(input.events));
  }
  if (input.uploadId) {
    formData.append("upload_id", input.uploadId);
  } else {
    formData.append("video", videoFormPart(input.videoUri));
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(`${workerUrl}/capture/record`, { method: "POST", body: formData }, RECORD_TIMEOUT_MS);
  } catch {
    throw new Error("Could not reach the worker. The record is saved and will be retried.");
  }

  // The server-side upload expired; retry immediately with the full video.
  if (response.status === 410 && input.uploadId) {
    return processRecord({ ...input, uploadId: undefined });
  }
  if (!response.ok) {
    throw new Error(await readDetail(response));
  }
  return (await response.json()) as RecordPayload;
}
