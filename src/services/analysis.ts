import type {
  AnalysisJob,
  ClipReview,
  CoachingReport,
  FrameGeometry,
  FrameLine,
  FramePoint,
  JumpRecord,
  MetricPhase,
  PoseMetric,
  RideSession,
  SkillType,
  VideoAsset
} from "../types/domain";

const skillLabels: Record<SkillType, string> = {
  regular_jump: "Regular jump",
  bunnyhop: "Bunnyhop",
  manual: "Manual",
  wheelie: "Wheelie",
  drop: "Drop"
};

export function getSkillLabel(skillType: SkillType): string {
  return skillLabels[skillType];
}

/** Records are titled by when they happened — that's how riders recall clips.
 * The what-layer lives in tags (auto crash tag + user tags), not the title. */
export function getRecordTitle(record: JumpRecord): string {
  const created = new Date(record.createdAt);
  const now = new Date();
  const time = created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (created.toDateString() === now.toDateString()) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (created.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  return `${created.toLocaleDateString([], { day: "numeric", month: "short" })} · ${time}`;
}

/** Tags the pipeline already knows without the rider typing anything: the AI
 * review classifies each record (clean_jump / crash / …), so crashes and clean
 * runs tag themselves. */
export function getSystemTags(record: JumpRecord): string[] {
  const crashed = record.eventType === "crash" || (record.events ?? []).some((event) => event.name === "crash");
  if (crashed) return ["crash"];
  if (record.eventType === "clean_jump") return ["clean"];
  return [];
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createQueuedSession(skillType: SkillType, videoUri: string, clip?: ClipReview): RideSession {
  const now = new Date().toISOString();
  const sessionId = createId("session");
  const durationSeconds = clip?.durationSeconds ?? 6;
  const video: VideoAsset = {
    id: createId("video"),
    sessionId,
    rawVideoUri: videoUri,
    durationSeconds,
    fps: 60,
    trimStartSeconds: clip?.trimStartSeconds ?? 0,
    trimEndSeconds: clip?.trimEndSeconds ?? Math.min(10, durationSeconds),
    cropPreset: clip?.cropPreset ?? "full_side_view",
    createdAt: now
  };
  const job: AnalysisJob = {
    id: createId("job"),
    sessionId,
    status: "queued",
    progress: 0,
    startedAt: now
  };

  return {
    id: sessionId,
    userId: "demo-user",
    skillType,
    status: "uploaded",
    title: `${getSkillLabel(skillType)} analysis`,
    createdAt: now,
    video,
    job,
    metrics: []
  };
}

export type FrameMediaSource = {
  videoUri?: string;
  imageUri?: string;
};

export function getFrameMediaSource(session: RideSession): FrameMediaSource | undefined {
  if (session.video?.rawVideoUri && !session.video.rawVideoUri.startsWith("demo://")) {
    return { videoUri: session.video.rawVideoUri };
  }

  return undefined;
}

export function hasVerifiedGeometry(metric?: PoseMetric): boolean {
  return metric?.geometrySource === "detected" || metric?.geometrySource === "manual";
}

export function getGeometrySourceLabel(metric?: PoseMetric): string {
  if (metric?.geometrySource === "detected") return "Detected";
  if (metric?.geometrySource === "manual") return "Manual";
  return "Calibration required";
}

export function applyManualFrameGeometry(metric: PoseMetric, geometry: FrameGeometry, frameTime = metric.frameTime): PoseMetric {
  return {
    ...metric,
    frameTime,
    torsoAngle: Math.round(getAngleBetweenLines(geometry.torso, geometry.floor)),
    kneeAngle: Math.round(getJointAngle(geometry.kneeUpper.start, geometry.kneeUpper.end, geometry.kneeLower.end)),
    floorAngle: Math.round(getLineAngle(geometry.floor)),
    tireBaselineAngle: Math.round(getLineAngle(geometry.tireBaseline)),
    landingAlignmentAngle: Math.round(getLineAngle(geometry.landing)),
    bikePitchAngle: Math.round(getLineAngle(geometry.tireBaseline)),
    geometrySource: "manual",
    geometry,
    confidence: 0.95
  };
}

export function getLineAngle(line: FrameLine): number {
  return normalizeAngle((Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x) * 180) / Math.PI);
}

export function getAngleBetweenLines(first: FrameLine, second: FrameLine): number {
  const diff = Math.abs(normalizeAngle(getLineAngle(first) - getLineAngle(second)));
  return Math.min(diff, 180 - diff);
}

export function getJointAngle(first: FramePoint, joint: FramePoint, second: FramePoint): number {
  const firstVector = { x: first.x - joint.x, y: first.y - joint.y };
  const secondVector = { x: second.x - joint.x, y: second.y - joint.y };
  const firstMagnitude = Math.hypot(firstVector.x, firstVector.y);
  const secondMagnitude = Math.hypot(secondVector.x, secondVector.y);

  if (firstMagnitude === 0 || secondMagnitude === 0) {
    return 0;
  }

  const cosine = clamp(
    (firstVector.x * secondVector.x + firstVector.y * secondVector.y) / (firstMagnitude * secondMagnitude),
    -1,
    1
  );

  return (Math.acos(cosine) * 180) / Math.PI;
}

export function normalizeAngle(angle: number): number {
  let next = angle;
  while (next > 180) next -= 360;
  while (next < -180) next += 360;
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const calibrationPhases: Array<{ phase: MetricPhase; ratio: number }> = [
  { phase: "approach", ratio: 0.12 },
  { phase: "compression", ratio: 0.32 },
  { phase: "takeoff", ratio: 0.48 },
  { phase: "air", ratio: 0.66 },
  { phase: "landing", ratio: 0.86 }
];

// Empty frames for manual calibration only. All angles stay 0 and geometrySource
// stays unset ("Calibration required") until the rider places the geometry lines.
export function createCalibrationMetrics(session: RideSession): PoseMetric[] {
  const video = session.video;
  const start = video?.trimStartSeconds ?? 0;
  const end = video?.trimEndSeconds ?? video?.durationSeconds ?? 6;
  const window = Math.max(0.5, end - start);

  return calibrationPhases.map(({ phase, ratio }) => ({
    id: createId(`metric-${phase}`),
    sessionId: session.id,
    phase,
    frameTime: Number((start + window * ratio).toFixed(2)),
    torsoAngle: 0,
    hipAngle: 0,
    kneeAngle: 0,
    elbowAngle: 0,
    bikePitchAngle: 0,
    confidence: 0
  }));
}

export function createRuleBasedReport(session: RideSession, metrics: PoseMetric[]): CoachingReport {
  const takeoff = metrics.find((metric) => metric.phase === "takeoff");
  const landing = metrics.find((metric) => metric.phase === "landing");
  const tireBaseline = takeoff?.tireBaselineAngle ?? takeoff?.bikePitchAngle ?? 0;
  const landingAlignment = landing?.landingAlignmentAngle ?? 0;
  const elbowAngle = takeoff?.elbowAngle ?? 0;
  const confidence = Math.min(...metrics.map((metric) => metric.confidence));

  const improvements = [
    "Check the floor line first, then compare both tire centers against that baseline.",
    "Keep torso, knee, and landing alignment stacked over the bike instead of chasing the bars."
  ];

  if (tireBaseline < -4) {
    improvements.push("The tire baseline trends nose-low; keep light pressure through the bars after takeoff.");
  }

  if (Math.abs(landingAlignment) > 8 || (landing?.torsoAngle ?? 50) < 46) {
    improvements.push("On landing, bring the torso slightly taller and keep hips closer to the tire baseline.");
  }

  return {
    id: createId("report"),
    sessionId: session.id,
    summary:
      confidence < 0.72
        ? "The clip is usable, but some frames are uncertain. Treat this as directional coaching, not a final score."
        : "Your jump is controlled through takeoff, with the main opportunity in extension timing and landing position.",
    strengths: [
      "The side-view frame is usable for floor, tire baseline, torso, knee, and landing alignment review.",
      tireBaseline > -7 ? "The tire baseline stays reasonably controlled in the air." : "The takeoff phase is readable enough to review tire baseline timing.",
      elbowAngle > 150 ? "Arm extension is strong at takeoff." : "Upper-body position stays compact before takeoff."
    ],
    improvements,
    drills: [
      "Do 5 pump-throughs on the lip without leaving the ground.",
      "Practice small-table jumps while matching arm and leg extension.",
      "Film again from the same side angle and compare takeoff frame time."
    ],
    createdAt: new Date().toISOString()
  };
}

export function formatReportShareText(session: RideSession): string {
  const report = session.report;
  if (!report) {
    return "RiderLens report is still processing.";
  }

  return [
    `RiderLens ${getSkillLabel(session.skillType)} report`,
    "",
    report.summary,
    "",
    "Improvements:",
    ...report.improvements.map((item) => `- ${item}`),
    "",
    "Drills:",
    ...report.drills.map((item) => `- ${item}`)
  ].join("\n");
}
