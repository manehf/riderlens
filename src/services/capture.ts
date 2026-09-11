import type { CaptureEvent, FilmstripFrame, FlightEstimate, SeriesPoint } from "../types/domain";
import { getWorkerUrlCandidates } from "./analysisWorker";
import { parseRetryAfter } from "./analysisRetry";
import { getAnalysisTransport, nativeAnalysisSubmissionsEnabled, watchAnalysisBackground } from "./analysisTransport";
import type { TransferSnapshot } from "./analysisTransport.types";

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
const RESULT_RECOVERY_TIMEOUT_MS = 30_000;

export type RecordProcessingFailureStage =
  | "worker_reachability"
  | "result_recovery"
  | "request_timeout"
  | "request_transport"
  | "upload_prepare"
  | "upload_timeout"
  | "upload_transport"
  | "worker_response"
  | "response_download";

export class RecordProcessingError extends Error {
  /** A terminal receipt is ACKed only after the hook persists this outcome. */
  transfer?: TransferSnapshot;
  constructor(
    message: string,
    readonly failureStage: RecordProcessingFailureStage,
    readonly retryable: boolean,
    cause?: unknown,
    readonly retryAfterMs?: number
  ) {
    super(message);
    Object.defineProperty(this, "transfer", { value: undefined, writable: true, enumerable: false });
    this.name = "RecordProcessingError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class WorkerResponseError extends RecordProcessingError {
  constructor(message: string, readonly status: number, retryAfterMs?: number) {
    super(message, "worker_response", status === 408 || status === 429 || status >= 500, undefined, retryAfterMs);
    this.name = "WorkerResponseError";
  }
}

/** A successful submission/status check awaiting the next foreground poll. */
export class RecordWaitingError extends RecordProcessingError {
  constructor(readonly jobId: string, retryAfterMs = 10_000, readonly phase: "queued" | "analysing" = "queued") {
    super("Waiting for analysis. Your video is saved and will continue automatically.", "worker_response", true, undefined, retryAfterMs);
    this.name = "RecordWaitingError";
  }
}

/** Scheduling/progress is successful work; it must not hold the JS queue open. */
export class RecordTransferWaitingError extends RecordProcessingError {
  constructor(snapshot?: TransferSnapshot) {
    super(snapshot ? "Sending your video. You can return later to check the analysis."
      : "Waiting to send your video. It is saved on this device.", "request_transport", true, undefined, 5_000);
    this.name = "RecordTransferWaitingError";
    this.transfer = snapshot;
  }
}

export class RecordSubmissionFallbackError extends RecordProcessingError {
  constructor(readonly legacySubmission: boolean) {
    super("Updating the upload method. Your video is saved and will retry.", "worker_response", true, undefined, 0);
    this.name = "RecordSubmissionFallbackError";
  }
}

/** Deliberately stopped a foreground read; this is deferred work, not failure. */
export class RecordForegroundWaitingError extends RecordProcessingError {
  constructor() {
    super("Your analysis is saved. Open RiderLens to continue checking the result.", "result_recovery", true, undefined, 1_000);
    this.name = "RecordForegroundWaitingError";
  }
}

export class RecordJobFailedError extends RecordProcessingError {
  constructor(message: string, retryable: boolean) {
    super(message, "worker_response", retryable);
    this.name = "RecordJobFailedError";
  }
}

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
    return await fetchJsonWithTimeout(`${workerUrl}/health`, { method: "GET" }, timeoutMs, async (response) => {
      if (!response.ok) return false;
      // Older workers omit the capability and keep the original synchronous API.
      const health = await response.json().catch(() => ({}));
      workerCapabilities.set(workerUrl, health.captureJobsEnabled === true);
      return true;
    });
  } catch (error) {
    if (error instanceof RecordForegroundWaitingError) throw error;
    return false;
  }
}

const workerCapabilities = new Map<string, boolean>();

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

export type BillingEventName = "allowance_exhausted" | "allowance_blocked" | "paywall_requested" | "paywall_result" | "billing_error" | "restore_result";

export type WorkerAnalyticsEvent = {
  clientId: string;
  eventId: string;
  name: "analysis_started" | "analysis_completed" | "analysis_failed" | "analysis_retry" | BillingEventName;
  timestampMicros: number;
  sessionId: number;
  platform: "ios" | "android";
  appVersion: string;
  parameters: Record<string, string | number | boolean>;
};

/** Deliver one queued product event through the trusted worker. The GA4 API
 * secret stays server-side; callers retain and retry the event on any error. */
export async function sendAnalyticsEventToWorker(event: WorkerAnalyticsEvent): Promise<void> {
  const workerUrl = await resolveWorkerUrl();
  if (!workerUrl) throw new Error("Could not reach the analytics service.");
  const response = await fetchWithTimeout(
    `${workerUrl}/analytics/event`,
    {
      method: "POST",
      headers: { ...workerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(event)
    },
    10_000
  );
  if (!response.ok) throw new Error(`Analytics service responded ${response.status}.`);
}

export type ProcessRecordInput = {
  videoUri: string;
  uploadId?: string;
  /** Idempotency key shared by an initial request and all of its retries. */
  requestId?: string;
  /** Check for a result that the worker completed after the client disconnected. */
  recoverCompleted?: boolean;
  jobId?: string;
  legacySubmission?: boolean;
  canSubmit?: () => boolean;
  onPhase?: (phase: "downloading") => void;
  startSeconds: number;
  endSeconds: number;
  events?: CaptureEvent[];
  rotateDegrees?: number;
};

async function readRecordPayload(response: Response): Promise<RecordPayload> {
  try {
    return (await response.json()) as RecordPayload;
  } catch (error) {
    throw new RecordProcessingError(
      "The analysis finished, but its result could not be downloaded. The record is saved and will retry.",
      "response_download",
      true,
      error
    );
  }
}

async function recoverCompletedRecord(workerUrl: string, requestId: string, onPhase?: ProcessRecordInput["onPhase"]): Promise<RecordPayload | null> {
  try {
    return await fetchJsonWithTimeout(
      `${workerUrl}/capture/result/${encodeURIComponent(requestId)}`,
      { method: "GET" },
      RESULT_RECOVERY_TIMEOUT_MS,
      async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw await responseError(response);
        onPhase?.("downloading");
        return await readRecordPayload(response);
      }
    );
  } catch (error) {
    if (error instanceof RecordProcessingError) throw error;
    throw new RecordProcessingError(
      "Could not recover the completed analysis yet. The record is saved and will retry.",
      "result_recovery",
      true,
      error
    );
  }
}

async function responseError(response: Response): Promise<WorkerResponseError> {
  return new WorkerResponseError(await readDetail(response), response.status, parseRetryAfter(response.headers.get("Retry-After")));
}

// Keep the deadline alive through JSON transfer, including polling/results.
async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let leftForeground = false;
  const stopWatching = watchAnalysisBackground(() => { leftForeground = true; controller.abort(); });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, headers: { ...workerHeaders(), ...init.headers }, signal: controller.signal });
    return await read(response);
  } catch (error) {
    if (leftForeground) throw new RecordForegroundWaitingError();
    throw error;
  } finally {
    clearTimeout(timeout);
    stopWatching();
  }
}

type CaptureJob = { jobId: string; status: "queued" | "processing" | "ready" | "failed"; retryAfterSeconds?: number; error?: string; retryable?: boolean };

async function handleCaptureJob(workerUrl: string, job: CaptureJob, onPhase?: ProcessRecordInput["onPhase"]): Promise<RecordPayload | null> {
  if (!job.jobId || !["queued", "processing", "ready", "failed"].includes(job.status)) {
    throw new RecordProcessingError("Invalid analysis job response. Please retry.", "worker_response", true);
  }
  if (job.status === "ready") return await recoverCompletedRecord(workerUrl, job.jobId, onPhase);
  if (job.status === "failed") {
    throw new RecordJobFailedError(job.error || "Analysis failed. Please retry.", job.retryable === true);
  }
  const delay = Number.isFinite(job.retryAfterSeconds) ? Math.max(1, job.retryAfterSeconds!) * 1000 : 10_000;
  throw new RecordWaitingError(job.jobId, delay, job.status === "processing" ? "analysing" : "queued");
}

async function pollCaptureJob(workerUrl: string, jobId: string, resubmitRetryableFailure = false, onPhase?: ProcessRecordInput["onPhase"]): Promise<RecordPayload | null> {
  return await fetchJsonWithTimeout(`${workerUrl}/capture/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 30_000, async (response) => {
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    const job = await response.json() as CaptureJob;
    if (job.jobId !== jobId) throw new RecordProcessingError("The analysis service returned a different job. Please retry.", "worker_response", true);
    if (resubmitRetryableFailure && job.status === "failed" && job.retryable === true) return null;
    return await handleCaptureJob(workerUrl, job, onPhase);
  });
}

/** Interpret the small, durable native receipt without any network request.
 * Acceptance is persisted before a potentially interruptible result download. */
function nativeTransferOutcome(snapshot: TransferSnapshot): never {
  let error: RecordProcessingError;
  if (snapshot.state !== "terminal") throw new RecordTransferWaitingError(snapshot);
  const status = snapshot.status;
  const retryAfterMs = parseRetryAfter(snapshot.retryAfter ?? null);
  let body: { jobId?: string; status?: string; retryAfterSeconds?: number; detail?: unknown } = {};
  try { body = JSON.parse(snapshot.body ?? "{}"); } catch { /* Recover uncertain acceptance by request ID. */ }
  if (status && status >= 200 && status < 300 && !snapshot.errorDomain) {
    if (body?.jobId === snapshot.attemptId && ["queued", "processing", "ready", "failed"].includes(body.status ?? "")) {
      // Even a failed/ready job is durably accepted; poll it after ACK to use the
      // existing job failure/result path and avoid downloading before persistence.
      const delay = body.status === "ready" || body.status === "failed" ? 0
        : Number.isFinite(body.retryAfterSeconds) ? Math.max(1, body.retryAfterSeconds!) * 1000 : 10_000;
      error = new RecordWaitingError(snapshot.attemptId, delay, body.status === "processing" ? "analysing" : "queued");
    } else {
      error = new RecordProcessingError("Could not confirm the upload response. Your video is saved; RiderLens will check before retrying.", "worker_response", true);
    }
  } else if (status === 410 || status === 404 || status === 405) {
    error = new RecordSubmissionFallbackError(status !== 410);
  } else if (status && status >= 400) {
    error = new WorkerResponseError(typeof body?.detail === "string" ? body.detail : `Upload service responded ${status}.`, status, retryAfterMs);
  } else {
    const timedOut = snapshot.errorDomain === "NSURLErrorDomain" && snapshot.errorCode === -1001;
    const preparation = Boolean(snapshot.errorDomain && snapshot.errorDomain !== "NSURLErrorDomain" &&
      !["E_TRANSFER_OUTCOME_UNKNOWN", "E_TRANSFER_RESPONSE_TOO_LARGE"].includes(snapshot.errorDomain));
    error = new RecordProcessingError(timedOut
      ? "The video upload timed out. Your video is saved; RiderLens will check before retrying."
      : preparation ? "Could not prepare the video upload. Your video is saved on this device."
      : "The video transfer was interrupted. Your video is saved; RiderLens will check before retrying.",
      timedOut ? "upload_timeout" : preparation ? "upload_prepare" : "upload_transport", snapshot.errorDomain !== "E_TRANSFER_INPUT");
  }
  error.transfer = snapshot;
  throw error;
}

/** Publish an explicitly shared clip and return its public page URL. */
export async function createShareLink(
  videoUri: string,
  airtimeSeconds?: number,
  riderName?: string
): Promise<string> {
  const workerUrl = await resolveWorkerUrl();
  if (!workerUrl) {
    throw new Error("Could not reach the share service. Check your connection and retry.");
  }
  const formData = new FormData();
  formData.append("video", videoFormPart(videoUri));
  if (airtimeSeconds) {
    formData.append("airtime_seconds", String(airtimeSeconds));
  }
  if (riderName?.trim()) {
    formData.append("rider_name", riderName.trim());
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${workerUrl}/share`, {
      method: "POST",
      headers: workerHeaders(),
      body: formData,
      signal: controller.signal
    });
    if (!response.ok) {
      throw new WorkerResponseError(await readDetail(response), response.status);
    }
    const payload = (await response.json()) as { shareUrl?: string };
    if (!payload.shareUrl) {
      throw new Error("The share service returned no link.");
    }
    return payload.shareUrl;
  } finally {
    clearTimeout(timeout);
  }
}

/** Turn a confirmed window into the record. Throws with a readable message on failure
 * so the record can be kept as pending and retried later. */
export async function processRecord(input: ProcessRecordInput): Promise<RecordPayload> {
  const nativeTransport = getAnalysisTransport();
  const nativeSubmissions = nativeAnalysisSubmissionsEnabled();
  // Do this before reachability, polling, deadlines or fallback. A live task or
  // unconsumed receipt takes precedence, even when the server is unreachable.
  const nativeSnapshots = nativeTransport ? await nativeTransport.reconcile() : [];
  if (input.requestId) {
    const existing = nativeSnapshots.find((task) => task.attemptId === input.requestId);
    if (existing) nativeTransferOutcome(existing);
  }
  if (getWorkerUrlCandidates().length === 0) {
    throw new RecordProcessingError(
      "No analysis worker configured. Set EXPO_PUBLIC_ANALYSIS_WORKER_URL.",
      "worker_reachability",
      false
    );
  }
  const workerUrl = await resolveWorkerUrl();
  if (!workerUrl) {
    throw new RecordProcessingError(
      "Could not reach the worker. The record is saved and will be retried.",
      "worker_reachability",
      true
    );
  }

  // The app can die after the server accepted a job but before its response was
  // persisted. The pre-upload attempt ID also recovers that unacknowledged job.
  const recoverJobId = input.jobId ?? (input.recoverCompleted && workerCapabilities.get(workerUrl) && !input.legacySubmission ? input.requestId : undefined);
  if (recoverJobId) {
    try {
      const result = await pollCaptureJob(workerUrl, recoverJobId, !input.jobId, input.onPhase);
      if (result) return result;
    } catch (error) {
      if (error instanceof RecordProcessingError) throw error;
      throw new RecordProcessingError("Could not check analysis progress. Your video is saved and will retry.", "result_recovery", true, error);
    }
  }

  if (input.recoverCompleted && input.requestId) {
    const recovered = await recoverCompletedRecord(workerUrl, input.requestId, input.onPhase);
    if (recovered) return recovered;
  }

  const fields: Record<string, string> = {
    start_seconds: String(input.startSeconds), end_seconds: String(input.endSeconds)
  };
  if (input.events && input.events.length > 0) {
    fields.events_json = JSON.stringify(input.events);
  }
  if (input.rotateDegrees) {
    fields.rotate_degrees = String(input.rotateDegrees);
  }
  if (input.uploadId) {
    fields.upload_id = input.uploadId;
  }
  if (input.requestId) {
    fields.request_id = input.requestId;
  }

  if (input.canSubmit && !input.canSubmit()) throw new RecordTransferWaitingError();
  if (!nativeSubmissions && nativeSnapshots.some((task) => task.state !== "terminal")) {
    throw new RecordTransferWaitingError(); // Drain before any foreground fallback.
  }
  const useJobs = Boolean(input.requestId && workerCapabilities.get(workerUrl) && !input.legacySubmission);
  // Local HTTP development workers keep the foreground transport. Background
  // uploads only admit HTTPS endpoints; store builds use the deployed HTTPS URL.
  if (nativeTransport && nativeSubmissions && useJobs && workerUrl.startsWith("https://")) {
    try {
      const snapshot = await nativeTransport.ensureUpload({
        attemptId: input.requestId!, url: `${workerUrl}/capture/jobs`,
        sourceUri: input.uploadId ? undefined : input.videoUri, fields, headers: workerHeaders()
      });
      nativeTransferOutcome(snapshot);
    } catch (error) {
      if (error instanceof RecordProcessingError) throw error;
      if (["E_TRANSFER_BUSY", "E_TRANSFER_BACKGROUND"].includes((error as { code?: string })?.code ?? "")) throw new RecordTransferWaitingError();
      throw new RecordProcessingError("Could not prepare the video transfer. Your video is saved on this device.", "upload_prepare",
        !["E_TRANSFER_INPUT", "E_TRANSFER_CONFLICT"].includes((error as { code?: string })?.code ?? ""));
    }
  }
  const formData = new FormData();
  for (const [name, value] of Object.entries(fields)) formData.append(name, value);
  if (!input.uploadId) formData.append("video", videoFormPart(input.videoUri));

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RECORD_TIMEOUT_MS);
  try {
    const response = await fetch(`${workerUrl}/capture/${useJobs ? "jobs" : "record"}`, {
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
      if (useJobs && (response.status === 404 || response.status === 405)) {
        workerCapabilities.set(workerUrl, false);
        return await processRecord({ ...input, jobId: undefined });
      }
      throw await responseError(response);
    }

    if (useJobs) {
      const result = await handleCaptureJob(workerUrl, await response.json());
      if (result) return result;
      throw new RecordProcessingError("The completed analysis is unavailable. Please retry.", "result_recovery", true);
    }

    // Keep the timeout alive through body transfer and JSON parsing. React
    // Native fetch can resolve after headers while a large body is still being
    // received; clearing it there left records in "processing" forever.
    return await readRecordPayload(response);
  } catch (error) {
    if (error instanceof RecordProcessingError) throw error;
    throw new RecordProcessingError(
      timedOut
        ? "The analysis request timed out while sending or receiving data. The record is saved and will retry."
        : "The connection was interrupted while sending or receiving the analysis. The record is saved and will retry.",
      timedOut ? "request_timeout" : "request_transport",
      true,
      error
    );
  } finally {
    clearTimeout(timeout);
  }
}
