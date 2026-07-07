import Constants from "expo-constants";

import { createId } from "./analysis";
import type { CoachingReport, GeometrySource, MetricPhase, PoseMetric, RideSession } from "../types/domain";

// The worker listens on this port on the dev machine.
const WORKER_PORT = 8000;

/**
 * Host that served the JS bundle: `localhost` on the iOS Simulator (which shares
 * the Mac's network), the Mac's LAN IP on a physical phone loaded over Wi-Fi.
 * Reaching the worker on that same host avoids depending on mDNS `.local`
 * resolution, which the iOS Simulator blocks via iOS Local Network privacy.
 *
 * Only trusted for `localhost` or a bare IPv4 literal — a tunnel host
 * (`*.exp.direct`) proxies Metro only, not the worker port, so we fall back to
 * the explicit env URL in that case.
 */
function getDevBundlerHost(): string | undefined {
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost ?? undefined;
  const host = hostUri?.split(":")[0]?.trim();
  if (!host) return undefined;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return host === "localhost" || isIpLiteral ? host : undefined;
}

type WorkerMetric = {
  phase: MetricPhase;
  frameTime: number;
  torsoAngle: number;
  hipAngle: number;
  kneeAngle: number;
  elbowAngle: number;
  bikePitchAngle: number;
  floorAngle?: number;
  tireBaselineAngle?: number;
  landingAlignmentAngle?: number;
  geometrySource?: GeometrySource;
  geometry?: PoseMetric["geometry"];
  confidence: number;
};

type WorkerReport = {
  summary: string;
  strengths: string[];
  improvements: string[];
  drills: string[];
};

type WorkerResponse = {
  status: "completed";
  metrics: WorkerMetric[];
  report: WorkerReport;
};

export type WorkerAnalysisResult = {
  metrics: PoseMetric[];
  report: CoachingReport;
};

function getEnvWorkerUrl(): string | undefined {
  const rawUrl = process.env.EXPO_PUBLIC_ANALYSIS_WORKER_URL?.trim();
  if (!rawUrl) return undefined;
  return rawUrl.replace(/\/+$/, "");
}

/** Worker URLs in preference order: the dev bundler host first (Mac on the
 * same network — free and fast), then the deployed URL from env. The capture
 * service probes them in order and uses the first that answers /health. */
export function getWorkerUrlCandidates(): string[] {
  const candidates: string[] = [];
  const host = getDevBundlerHost();
  if (host) candidates.push(`http://${host}:${WORKER_PORT}`);
  const envUrl = getEnvWorkerUrl();
  if (envUrl && !candidates.includes(envUrl)) candidates.push(envUrl);
  return candidates;
}

export function getAnalysisWorkerUrl(): string | undefined {
  return getWorkerUrlCandidates()[0];
}

// Upload plus MediaPipe processing can legitimately take a while on long clips,
// but an unreachable worker (wrong LAN IP, firewall) would otherwise hang forever.
const ANALYSIS_TIMEOUT_MS = 120_000;

export async function analyzeRegularJumpWithWorker(session: RideSession): Promise<WorkerAnalysisResult | undefined> {
  const workerUrl = getAnalysisWorkerUrl();
  const video = session.video;

  if (!workerUrl || !video) {
    return undefined;
  }

  const formData = new FormData();
  formData.append("session_id", session.id);
  formData.append("trim_start_seconds", String(video.trimStartSeconds));
  formData.append("trim_end_seconds", String(video.trimEndSeconds));
  formData.append("crop_preset", video.cropPreset);
  formData.append("video", {
    uri: video.rawVideoUri,
    name: getVideoFileName(video.rawVideoUri),
    type: getVideoContentType(video.rawVideoUri)
  } as unknown as Blob);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${workerUrl}/analysis/regular-jump`, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `The analysis worker at ${workerUrl} did not respond within ${ANALYSIS_TIMEOUT_MS / 1000}s. Check that the phone and computer are on the same Wi-Fi and that the URL matches the computer's current IP.`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the analysis worker at ${workerUrl}. ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(detail || `Analysis worker failed with ${response.status}`);
  }

  const payload = (await response.json()) as WorkerResponse;
  return {
    metrics: payload.metrics.map((metric) => ({
      id: createId(`metric-${metric.phase}`),
      sessionId: session.id,
      phase: metric.phase,
      frameTime: metric.frameTime,
      torsoAngle: metric.torsoAngle,
      hipAngle: metric.hipAngle,
      kneeAngle: metric.kneeAngle,
      elbowAngle: metric.elbowAngle,
      bikePitchAngle: metric.bikePitchAngle,
      floorAngle: metric.floorAngle,
      tireBaselineAngle: metric.tireBaselineAngle,
      landingAlignmentAngle: metric.landingAlignmentAngle,
      geometrySource: metric.geometrySource,
      geometry: metric.geometry,
      confidence: metric.confidence
    })),
    report: {
      id: createId("report"),
      sessionId: session.id,
      summary: payload.report.summary,
      strengths: payload.report.strengths,
      improvements: payload.report.improvements,
      drills: payload.report.drills,
      createdAt: new Date().toISOString()
    }
  };
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const payload = await response.json();
    return typeof payload.detail === "string" ? payload.detail : undefined;
  } catch {
    return undefined;
  }
}

function getVideoFileName(uri: string): string {
  const name = uri.split("/").filter(Boolean).pop();
  return name?.includes(".") ? name : "riderlens-jump.mp4";
}

function getVideoContentType(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}
