export type SkillType =
  | "regular_jump"
  | "bunnyhop"
  | "manual"
  | "wheelie"
  | "drop";

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type SessionStatus = "draft" | "uploaded" | "analyzing" | "complete" | "reference";

export type MetricPhase = "approach" | "compression" | "takeoff" | "air" | "landing";
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

export type SessionSource = "video_upload" | "video_link";

export type VideoLinkProvider = "youtube" | "vimeo" | "instagram" | "tiktok" | "other";

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

export type VideoLinkReference = {
  url: string;
  provider: VideoLinkProvider;
  title?: string;
  notes?: string;
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
  confidence: number;
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
  source: SessionSource;
  title: string;
  createdAt: string;
  video?: VideoAsset;
  linkReference?: VideoLinkReference;
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
