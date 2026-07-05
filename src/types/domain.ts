export type SkillType =
  | "regular_jump"
  | "bunnyhop"
  | "manual"
  | "wheelie"
  | "drop";

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type SessionStatus = "draft" | "uploaded" | "analyzing" | "analysis_failed" | "complete";

export type MetricPhase = "approach" | "compression" | "takeoff" | "air" | "landing" | "crash";
export type GeometrySource = "detected" | "manual" | "estimated";

export type FramePoint = {
  x: number;
  y: number;
};

export type FrameLine = {
  start: FramePoint;
  end: FramePoint;
};

export type FrameGeometry = {
  floor: FrameLine;
  tireBaseline: FrameLine;
  torso: FrameLine;
  kneeUpper: FrameLine;
  kneeLower: FrameLine;
  landing: FrameLine;
};

export type PermissionLevel = "view" | "comment" | "edit";

export type VideoCropPreset =
  | "full_side_view"
  | "rider_centered"
  | "takeoff_landing"
  | "vertical_social";

export type ClipReview = {
  uri: string;
  durationSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  cropPreset: VideoCropPreset;
};

export type VideoAsset = {
  id: string;
  sessionId: string;
  rawVideoUri: string;
  annotatedVideoUri?: string;
  durationSeconds: number;
  fps: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  cropPreset: VideoCropPreset;
  createdAt: string;
};

export type PoseMetric = {
  id: string;
  sessionId: string;
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
  geometry?: FrameGeometry;
  bikeBox?: { x: number; y: number; w: number; h: number };
  confidence: number;
  frameImage?: string;
};

// --- Capture records (the product: find the moment, crop it, keep it) --------

export type CaptureEvent = {
  name: "approach" | "compression" | "takeoff" | "peak_air" | "landing" | "crash";
  time_seconds: number;
  why: string;
};

export type SeriesPoint = {
  t: number;
  kneeAngle: number | null;
  torsoAngle: number | null;
  hipHeight: number | null;
  pitch: number | null;
  confidence: number;
};

export type FilmstripFrame = {
  t: number;
  image: string;
};

/** Airtime + air height derived from flight physics (h = g·T²/8), timestamps
 * snapped to the pose series by the worker. Estimated, never measured.
 * A crash ends the flight too; height is then rise-only and may be null. */
export type FlightEstimate = {
  airtimeSeconds: number;
  heightMeters: number | null;
  method: "symmetric" | "rise_time";
  endedIn: "landing" | "crash";
  takeoffTime: number;
  landingTime: number;
};

export type RecordStatus = "pending" | "processing" | "ready" | "failed";

// Light metadata kept in the index; heavy payload (metrics/series/filmstrip) lives
// in each record's detail file on disk.
export type JumpRecord = {
  id: string;
  createdAt: string;
  skillType: SkillType;
  status: RecordStatus;
  sourceVideoUri: string;
  windowStart: number;
  windowEnd: number;
  aiWindow: boolean;
  eventType?: string;
  summary?: string;
  events?: CaptureEvent[];
  clipUri?: string;
  /** Skeleton-burned, watermarked share version of the clip. */
  skeletonClipUri?: string;
  /** Middle filmstrip frame saved to disk: the face of this record in lists. */
  posterUri?: string;
  /** Rider-added tags (trail, trick, "best", …) for finding records later. */
  tags?: string[];
  /** Present when the AI events describe a takeoff→landing flight. */
  flight?: FlightEstimate;
  error?: string;
};

export type JumpRecordDetail = {
  series: SeriesPoint[];
  filmstrip: FilmstripFrame[];
};

export type CoachingReport = {
  id: string;
  sessionId: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  drills: string[];
  createdAt: string;
};

export type AnalysisJob = {
  id: string;
  sessionId: string;
  status: JobStatus;
  progress: number;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type RideSession = {
  id: string;
  userId: string;
  skillType: SkillType;
  status: SessionStatus;
  title: string;
  createdAt: string;
  video?: VideoAsset;
  job?: AnalysisJob;
  metrics: PoseMetric[];
  report?: CoachingReport;
};

export type Bike = {
  id: string;
  userId: string;
  name: string;
  brand: string;
  model: string;
  year: number;
  discipline: string;
  createdAt: string;
};

export type BikeSetup = {
  id: string;
  bikeId: string;
  name: string;
  terrainType: string;
  ridingStyle: string;
  riderWeightWithGear: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type SuspensionSettings = {
  id: string;
  bikeSetupId: string;
  forkModel: string;
  shockModel: string;
  forkPressure: number;
  shockPressure: number;
  forkSagPercent: number;
  shockSagPercent: number;
  forkReboundClicks: number;
  shockReboundClicks: number;
  forkLscClicks: number;
  forkHscClicks: number;
  shockLscClicks: number;
  shockHscClicks: number;
  forkTokens: number;
  shockTokens: number;
  notes: string;
};

export type CockpitSettings = {
  id: string;
  bikeSetupId: string;
  barWidth: number;
  stemLength: number;
  stemSpacers: number;
  barRollAngle: number;
  brakeLeverAngle: number;
  saddleHeight: number;
  saddleAngle: number;
  notes: string;
};

export type TireSettings = {
  id: string;
  bikeSetupId: string;
  frontTireModel: string;
  rearTireModel: string;
  frontTirePressure: number;
  rearTirePressure: number;
  frontTireWidth: number;
  rearTireWidth: number;
  conditions: string;
  notes: string;
};

export type ServiceRecord = {
  id: string;
  bikeId: string;
  serviceType: string;
  serviceDate: string;
  odometerOrHours: number;
  shopName: string;
  mechanicName: string;
  notes: string;
  nextDueAt: string;
};

export type ToolMeasurement = {
  id: string;
  bikeId: string;
  bikeSetupId: string;
  measurementType: string;
  value: number;
  unit: "deg" | "%";
  notes: string;
  createdAt: string;
};

export type GarageState = {
  bike: Bike;
  setup: BikeSetup;
  suspension: SuspensionSettings;
  cockpit: CockpitSettings;
  tires: TireSettings;
  services: ServiceRecord[];
  measurements: ToolMeasurement[];
};
