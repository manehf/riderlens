import { CameraView, useCameraPermissions } from "expo-camera";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock3,
  Crop,
  Crosshair,
  FileVideo,
  Link2,
  RotateCcw,
  Scissors,
  Share2,
  Upload
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent
} from "react-native";

import { AnalysisFrames, FrameGeometryOverlay, FrameMediaBackground } from "../components/AnalysisFrames";
import { AppText, BrandHeader, Button, Card, Chip, Heading, MetricTile, NumberText, SectionHeader } from "../components/ui";
import { debugVideoReferences } from "../data/debugVideos";
import { spacing, tokens } from "../theme/tokens";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { getFrameMediaSource, getGeometrySourceLabel, hasVerifiedGeometry, type FrameMediaSource } from "../services/analysis";
import type { ClipReview, FrameGeometry, FramePoint, PoseMetric, RideSession, VideoCropPreset } from "../types/domain";

const cropPresets: Array<{ key: VideoCropPreset; label: string; detail: string }> = [
  { key: "full_side_view", label: "Full side", detail: "Rider and bike fully visible" },
  { key: "rider_centered", label: "Rider center", detail: "Keep rider centered in frame" },
  { key: "takeoff_landing", label: "Jump window", detail: "Prioritize lip, air, landing" },
  { key: "vertical_social", label: "Vertical", detail: "Phone/Shorts style crop" }
];

type CoachScreenProps = {
  store: RiderLensStore;
};

export function CoachScreen({ store }: CoachScreenProps) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [videoLink, setVideoLink] = useState("");
  const [recording, setRecording] = useState(false);
  const [calibrationMetricId, setCalibrationMetricId] = useState<string | undefined>();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const session = getLatestRegularJumpAnalysis(store.sessions);
  const mediaSource = session ? getFrameMediaSource(session) : undefined;
  const calibrationMetric = session?.metrics.find((metric) => metric.id === calibrationMetricId);
  const hasAnalysisPreview = Boolean(session && session.metrics.length > 0);
  const progress = session?.job?.progress ?? 0;
  const jobStatus = session?.job?.status ?? "completed";
  const complete = jobStatus === "completed";
  const debugRegularJumpVideo = debugVideoReferences.find((video) => video.skillType === "regular_jump");

  async function openCamera() {
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        return;
      }
    }
    setCameraOpen(true);
  }

  async function recordClip() {
    if (!cameraRef.current || recording) return;
    setRecording(true);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 10 });
      if (video?.uri) {
        store.prepareClipFromUri(video.uri, 10);
      }
      setCameraOpen(false);
    } finally {
      setRecording(false);
    }
  }

  function stopRecording() {
    cameraRef.current?.stopRecording?.();
  }

  async function uploadVideoFile() {
    setUploadOpen(false);
    setLinkMode(false);
    await store.uploadVideoFromLibrary();
  }

  function closeUploadModal() {
    setUploadOpen(false);
    setLinkMode(false);
  }

  function analyzeVideoLink() {
    const analyzing = store.analyzeVideoLink(videoLink);
    if (!analyzing) return;
    setVideoLink("");
    closeUploadModal();
  }

  return (
    <View style={styles.root}>
      <BrandHeader subtitle="Vision coach" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionHeader
          eyebrow="Coach"
          title="Regular jump analysis"
          body="Record or upload a short side-view clip. Keep the rider and bike fully visible, with good light and a stable camera."
        />

        <View style={styles.actionGrid}>
          <Button icon={Camera} onPress={openCamera} style={styles.actionButton}>
            Record
          </Button>
          <Button icon={Upload} variant="secondary" onPress={() => setUploadOpen(true)} style={styles.actionButton}>
            Upload
          </Button>
        </View>

        {store.pendingClip ? <ClipReviewCard store={store} clip={store.pendingClip} /> : null}

        {cameraOpen ? (
          <Card style={styles.cameraCard}>
            <View style={styles.cameraFrame}>
              <CameraView ref={cameraRef} mode="video" style={StyleSheet.absoluteFill} />
              <View style={styles.cameraHud}>
                <Chip tone="dark" icon={FileVideo}>
                  Side view
                </Chip>
                <Chip tone="dark" icon={Clock3}>
                  <NumberText color={tokens.electric} size={12} weight="bold">
                    10s
                  </NumberText>
                </Chip>
              </View>
            </View>
            <View style={styles.actionGrid}>
              <Button icon={recording ? CheckCircle2 : Camera} onPress={recording ? stopRecording : recordClip}>
                {recording ? "Stop" : "Start"}
              </Button>
              <Button variant="secondary" onPress={() => setCameraOpen(false)}>
                Cancel
              </Button>
            </View>
          </Card>
        ) : null}

        {hasAnalysisPreview && session ? (
          <AnalysisPreview session={session} mediaSource={mediaSource} onCalibrate={setCalibrationMetricId} />
        ) : null}

        {session?.job ? (
          <Card>
            <View style={styles.splitRow}>
              <View>
                <AppText weight="bold">Analysis job</AppText>
                <AppText color={tokens.textMuted} size={13}>
                  {complete ? "Report ready" : "Extracting frames and estimating key moments"}
                </AppText>
              </View>
              <Chip tone={complete ? "green" : "amber"}>{complete ? "Complete" : "Processing"}</Chip>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.max(8, Math.round(progress * 100))}%` }]} />
            </View>
            <View style={styles.progressLabel}>
              <NumberText weight="bold" color={tokens.green}>
                {Math.round(progress * 100)}%
              </NumberText>
            </View>
          </Card>
        ) : null}

        {session && session.metrics.length > 0 ? (
          <AnalysisFrames
            metrics={session.metrics}
            mediaSource={mediaSource}
            emptyText="No key frames were generated for this clip."
          />
        ) : null}

        {session?.report ? (
          <Card>
            <View style={styles.splitRow}>
              <Chip tone="cyan">Coaching report</Chip>
              <Button
                variant="secondary"
                icon={Share2}
                onPress={() => store.shareSessionReport(session.id)}
                style={styles.smallButton}
              >
                Share
              </Button>
            </View>
            <Heading level={3} style={styles.reportTitle}>
              Key takeaways
            </Heading>
            <AppText color={tokens.textMuted} style={styles.reportText}>
              {session.report.summary}
            </AppText>
            <View style={styles.reportList}>
              {session.report.improvements.slice(0, 3).map((item) => (
                <View key={item} style={styles.bulletRow}>
                  <View style={styles.bullet} />
                  <AppText size={14}>{item}</AppText>
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        <Card style={styles.warningCard}>
          <View style={styles.warningHeader}>
            <AlertTriangle color="#7a4b00" size={18} />
            <AppText weight="bold" color="#704400">
              Educational feedback only
            </AppText>
          </View>
          <AppText size={13} color="#704400">
            Bike skills involve risk. Practice within your ability, wear protective gear, and treat limited-video analysis as coaching guidance.
          </AppText>
        </Card>
      </ScrollView>

      <UploadSourceModal
        visible={uploadOpen}
        linkMode={linkMode}
        videoLink={videoLink}
        onChangeVideoLink={setVideoLink}
        onClose={closeUploadModal}
        onShowLink={() => setLinkMode(true)}
        onShowChoices={() => setLinkMode(false)}
        onUploadFile={uploadVideoFile}
        onAnalyzeLink={analyzeVideoLink}
        debugVideoUrl={__DEV__ ? debugRegularJumpVideo?.url : undefined}
      />

      {session && calibrationMetric ? (
        <ManualCalibrationModal
          visible={Boolean(calibrationMetricId)}
          metric={calibrationMetric}
          mediaSource={mediaSource}
          minFrameTime={session.video?.trimStartSeconds ?? 0}
          maxFrameTime={session.video?.trimEndSeconds ?? session.video?.durationSeconds ?? 30}
          onClose={() => setCalibrationMetricId(undefined)}
          onSave={(geometry, frameTime) => {
            store.calibrateSessionFrame(session.id, calibrationMetric.id, geometry, frameTime);
            setCalibrationMetricId(undefined);
          }}
        />
      ) : null}
    </View>
  );
}

function getLatestRegularJumpAnalysis(sessions: RideSession[]): RideSession | undefined {
  return sessions.find(
    (session) =>
      session.skillType === "regular_jump" &&
      session.source === "video_upload" &&
      !session.video?.rawVideoUri.startsWith("demo://")
  );
}

type UploadSourceModalProps = {
  visible: boolean;
  linkMode: boolean;
  videoLink: string;
  onChangeVideoLink: (value: string) => void;
  onClose: () => void;
  onShowLink: () => void;
  onShowChoices: () => void;
  onUploadFile: () => void;
  onAnalyzeLink: () => void;
  debugVideoUrl?: string;
};

function UploadSourceModal({
  visible,
  linkMode,
  videoLink,
  onChangeVideoLink,
  onClose,
  onShowLink,
  onShowChoices,
  onUploadFile,
  onAnalyzeLink,
  debugVideoUrl
}: UploadSourceModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Card style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <View style={styles.modalTitleBlock}>
              <Chip tone={linkMode ? "cyan" : "electric"} icon={linkMode ? Link2 : Upload}>
                {linkMode ? "Video link" : "Upload"}
              </Chip>
              <Heading level={3}>{linkMode ? "Paste video link" : "Choose source"}</Heading>
            </View>
          </View>

          {linkMode ? (
            <>
              <TextInput
                value={videoLink}
                onChangeText={onChangeVideoLink}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://www.youtube.com/watch?v=..."
                placeholderTextColor={tokens.textMuted}
                style={styles.linkInput}
              />
              <AppText color={tokens.textMuted} size={13}>
                Save a video link as a reference. Uploading the original file is required for MediaPipe geometry.
              </AppText>
              {debugVideoUrl ? (
                <Button
                  variant="secondary"
                  icon={Link2}
                  onPress={() => onChangeVideoLink(debugVideoUrl)}
                  style={styles.debugSampleButton}
                >
                  Debug sample
                </Button>
              ) : null}
              <View style={styles.actionGrid}>
                <Button icon={Link2} onPress={onAnalyzeLink} disabled={!videoLink.trim()} style={styles.actionButton}>
                  Save Reference
                </Button>
                <Button variant="secondary" onPress={onShowChoices} style={styles.actionButton}>
                  Back
                </Button>
              </View>
            </>
          ) : (
            <>
              <AppText color={tokens.textMuted} size={14} style={styles.modalBody}>
                Choose a video file for analysis or save a link as a reference.
              </AppText>
              <View style={styles.sourceList}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Upload video file"
                  onPress={onUploadFile}
                  style={({ pressed }) => [styles.sourceOption, pressed && styles.sourceOptionPressed]}
                >
                  <View style={styles.sourceIcon}>
                    <FileVideo color={tokens.green} size={20} />
                  </View>
                  <View style={styles.sourceText}>
                    <AppText weight="bold">Video file</AppText>
                    <AppText color={tokens.textMuted} size={13}>
                      Analyze jump frames, body lines, and angles.
                    </AppText>
                  </View>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Paste video link"
                  onPress={onShowLink}
                  style={({ pressed }) => [styles.sourceOption, pressed && styles.sourceOptionPressed]}
                >
                  <View style={styles.sourceIcon}>
                    <Link2 color={tokens.green} size={20} />
                  </View>
                  <View style={styles.sourceText}>
                    <AppText weight="bold">Video link</AppText>
                    <AppText color={tokens.textMuted} size={13}>
                      Save a YouTube or web video reference.
                    </AppText>
                  </View>
                </Pressable>
              </View>
              <Button variant="secondary" onPress={onClose}>
                Cancel
              </Button>
            </>
          )}
        </Card>
      </View>
    </Modal>
  );
}

function ClipReviewCard({ store, clip }: { store: RiderLensStore; clip: ClipReview }) {
  const selectedPreset = cropPresets.find((preset) => preset.key === clip.cropPreset) ?? cropPresets[0];
  const selectedDuration = Math.max(0, clip.trimEndSeconds - clip.trimStartSeconds);

  function setStart(value: number) {
    store.updatePendingClip({ trimStartSeconds: roundHalf(value) });
  }

  function setEnd(value: number) {
    store.updatePendingClip({ trimEndSeconds: roundHalf(value) });
  }

  return (
    <Card style={styles.clipReviewCard}>
      <View style={styles.splitRow}>
        <Chip tone="cyan" icon={Scissors}>
          Pre-upload clip
        </Chip>
        <NumberText color={tokens.textMuted} size={12} weight="bold">
          {selectedDuration.toFixed(1)}s selected
        </NumberText>
      </View>

      <View style={styles.trimSurface}>
        <View style={styles.trimTrack}>
          <View
            style={[
              styles.trimRange,
              {
                left: `${(clip.trimStartSeconds / clip.durationSeconds) * 100}%`,
                width: `${(selectedDuration / clip.durationSeconds) * 100}%`
              }
            ]}
          />
        </View>
        <View style={styles.trimTicks}>
          <NumberText color={tokens.textMuted} size={12}>
            0.0s
          </NumberText>
          <NumberText color={tokens.textMuted} size={12}>
            {clip.durationSeconds.toFixed(1)}s
          </NumberText>
        </View>
      </View>

      <View style={styles.trimGrid}>
        <TrimControl label="Jump start" value={clip.trimStartSeconds} onChange={setStart} />
        <TrimControl label="Jump end" value={clip.trimEndSeconds} onChange={setEnd} />
      </View>

      <View style={styles.cropBlock}>
        <View style={styles.cropHeader}>
          <Crop color={tokens.green} size={17} />
          <View>
            <AppText weight="bold">Crop/framing preset</AppText>
            <AppText color={tokens.textMuted} size={12}>
              {selectedPreset.detail}
            </AppText>
          </View>
        </View>
        <View style={styles.cropGrid}>
          {cropPresets.map((preset) => {
            const selected = preset.key === clip.cropPreset;
            return (
              <Pressable
                key={preset.key}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => store.updatePendingClip({ cropPreset: preset.key })}
                style={[styles.cropPreset, selected && styles.cropPresetActive]}
              >
                <AppText weight="bold" size={12} color={selected ? tokens.graphite : tokens.textMuted}>
                  {preset.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.clipNote}>
        <AppText size={13} color={tokens.textMuted}>
          RiderLens will save this clip in the app library, then analyze the selected jump window.
        </AppText>
      </View>

      <View style={styles.actionGrid}>
        <Button icon={Upload} onPress={store.confirmPendingClip}>
          Analyze Clip
        </Button>
        <Button variant="secondary" onPress={store.cancelPendingClip}>
          Cancel
        </Button>
      </View>
    </Card>
  );
}

function TrimControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <View style={styles.trimControl}>
      <AppText weight="bold" size={13}>
        {label}
      </AppText>
      <View style={styles.trimStepper}>
        <Button variant="secondary" onPress={() => onChange(value - 0.5)} style={styles.trimButton}>
          -
        </Button>
        <View style={styles.trimValue}>
          <NumberText weight="bold" size={18}>
            {value.toFixed(1)}
          </NumberText>
          <NumberText size={12} color={tokens.textMuted}>
            sec
          </NumberText>
        </View>
        <Button variant="secondary" onPress={() => onChange(value + 0.5)} style={styles.trimButton}>
          +
        </Button>
      </View>
    </View>
  );
}

function roundHalf(value: number) {
  return Math.round(value * 2) / 2;
}

function AnalysisPreview({
  session,
  mediaSource,
  onCalibrate
}: {
  session: RideSession;
  mediaSource?: FrameMediaSource;
  onCalibrate: (metricId: string) => void;
}) {
  const takeoff = session.metrics.find((metric) => metric.phase === "takeoff");
  const verifiedGeometry = hasVerifiedGeometry(takeoff);
  const calibrationCopy = getCalibrationCopy(session);

  if (!takeoff) {
    return null;
  }

  return (
    <Card tone="dark" style={styles.scanCard}>
      <View style={styles.scanSurface}>
        <FrameMediaBackground mediaSource={mediaSource} frameTime={takeoff.frameTime} />
        <View style={styles.scanTop}>
          <Chip tone="electric">Jump scan</Chip>
          <Chip tone={verifiedGeometry ? "green" : "amber"}>{getGeometrySourceLabel(takeoff)}</Chip>
        </View>
        {verifiedGeometry ? (
          <FrameGeometryOverlay metric={takeoff} variant="large" showLabels />
        ) : (
          <CalibrationPreviewOverlay title={calibrationCopy.previewTitle} body={calibrationCopy.previewBody} />
        )}
        <View style={styles.scanBottom}>
          <AppText color="rgba(255,255,255,0.78)" weight="semi" size={13}>
            Takeoff frame
          </AppText>
          <NumberText color={tokens.surface} weight="bold" size={13}>
            {takeoff.frameTime.toFixed(1)}s
          </NumberText>
        </View>
      </View>
      {verifiedGeometry ? (
        <>
          <View style={styles.metricGrid}>
            <MetricTile tone="dark" label="Floor" value={takeoff.floorAngle ?? 0} unit="deg" />
            <MetricTile tone="dark" label="Tire base" value={takeoff.tireBaselineAngle ?? takeoff.bikePitchAngle} unit="deg" />
            <MetricTile tone="dark" label="Knee" value={takeoff.kneeAngle} unit="deg" />
          </View>
          <View style={styles.calibrationActionRow}>
            <Button icon={Crosshair} variant="dark" onPress={() => onCalibrate(takeoff.id)} style={styles.calibrationButton}>
              Adjust calibration
            </Button>
          </View>
        </>
      ) : (
        <View style={styles.calibrationSummary}>
          <AppText weight="bold" color={tokens.surface}>
            {calibrationCopy.title}
          </AppText>
          <AppText color="rgba(255,255,255,0.7)" size={13}>
            {calibrationCopy.body}
          </AppText>
          <Button icon={Crosshair} variant="dark" onPress={() => onCalibrate(takeoff.id)} style={styles.calibrationButton}>
            {calibrationCopy.action}
          </Button>
        </View>
      )}
    </Card>
  );
}

function getCalibrationCopy(session: RideSession) {
  if (session.source === "video_link") {
    return {
      previewTitle: "Reference link",
      previewBody: "Upload the original clip for MediaPipe frame geometry.",
      title: "Linked video is reference-only.",
      body: "YouTube and web links only provide a thumbnail in this MVP. Upload the original video file to detect floor, tires, torso, knee, and landing geometry.",
      action: "Calibrate thumbnail"
    };
  }

  return {
    previewTitle: "Calibration required",
    previewBody: "Mark key lines or check the worker before trusting angles.",
    title: "Fallback geometry is in use.",
    body: "MediaPipe did not provide verified geometry for this result. Check the worker connection, then upload the original clip again or calibrate this frame manually.",
    action: "Calibrate frame"
  };
}

function CalibrationPreviewOverlay({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.calibrationPreviewOverlay}>
      <View style={styles.calibrationPreviewPanel}>
        <AppText weight="bold" color={tokens.surface}>
          {title}
        </AppText>
        <AppText color="rgba(255,255,255,0.74)" size={13} style={styles.calibrationPreviewText}>
          {body}
        </AppText>
      </View>
    </View>
  );
}

type CalibrationPointKey =
  | "floorStart"
  | "floorEnd"
  | "rearTire"
  | "frontTire"
  | "hip"
  | "shoulder"
  | "knee"
  | "ankle"
  | "landingStart"
  | "landingEnd";

type CalibrationPoints = Partial<Record<CalibrationPointKey, FramePoint>>;

const zoomLevels = [1, 1.5, 2, 3];

const calibrationSteps: Array<{
  key: CalibrationPointKey;
  label: string;
  detail: string;
  marker: string;
  color: string;
}> = [
  {
    key: "floorStart",
    label: "Floor start",
    detail: "Tap the left side of the visible floor or ground line.",
    marker: "F1",
    color: "rgba(255,255,255,0.95)"
  },
  {
    key: "floorEnd",
    label: "Floor end",
    detail: "Tap the right side of that same floor line.",
    marker: "F2",
    color: "rgba(255,255,255,0.95)"
  },
  {
    key: "rearTire",
    label: "Rear tire center",
    detail: "Tap the center of the rear wheel.",
    marker: "R",
    color: tokens.electric
  },
  {
    key: "frontTire",
    label: "Front tire center",
    detail: "Tap the center of the front wheel.",
    marker: "W",
    color: tokens.electric
  },
  {
    key: "hip",
    label: "Hip",
    detail: "Tap the rider hip closest to the camera.",
    marker: "H",
    color: tokens.cyan
  },
  {
    key: "shoulder",
    label: "Shoulder",
    detail: "Tap the rider shoulder closest to the camera.",
    marker: "S",
    color: tokens.cyan
  },
  {
    key: "knee",
    label: "Knee",
    detail: "Tap the rider knee closest to the camera.",
    marker: "K",
    color: "#f6ff63"
  },
  {
    key: "ankle",
    label: "Ankle",
    detail: "Tap the rider ankle or pedal-side foot point.",
    marker: "A",
    color: "#f6ff63"
  },
  {
    key: "landingStart",
    label: "Landing start",
    detail: "Tap the start of the landing slope or intended landing line.",
    marker: "L1",
    color: "#ff4fd8"
  },
  {
    key: "landingEnd",
    label: "Landing end",
    detail: "Tap the end of the landing slope or intended landing line.",
    marker: "L2",
    color: "#ff4fd8"
  }
];

function ManualCalibrationModal({
  visible,
  metric,
  mediaSource,
  minFrameTime,
  maxFrameTime,
  onClose,
  onSave
}: {
  visible: boolean;
  metric: PoseMetric;
  mediaSource?: FrameMediaSource;
  minFrameTime: number;
  maxFrameTime: number;
  onClose: () => void;
  onSave: (geometry: FrameGeometry, frameTime: number) => void;
}) {
  const [points, setPoints] = useState<CalibrationPoints>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [selectedFrameTime, setSelectedFrameTime] = useState(metric.frameTime);
  const [zoomLevel, setZoomLevel] = useState(1);
  const geometry = buildFrameGeometry(points);
  const complete = Boolean(geometry);
  const currentStep = calibrationSteps[Math.min(stepIndex, calibrationSteps.length - 1)];
  const frameOptions = getTakeoffFrameOptions(metric.frameTime, minFrameTime, maxFrameTime);

  useEffect(() => {
    const initialPoints = metric.geometry ? getCalibrationPointsFromGeometry(metric.geometry) : {};
    const firstMissingIndex = calibrationSteps.findIndex((step) => !initialPoints[step.key]);
    setPoints(initialPoints);
    setStepIndex(firstMissingIndex >= 0 ? firstMissingIndex : calibrationSteps.length);
    setSelectedFrameTime(metric.frameTime);
    setZoomLevel(1);
  }, [metric.frameTime, metric.geometry, metric.id]);

  function handleFrameLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setFrameSize({ width, height });
  }

  function handleFramePress(event: GestureResponderEvent) {
    if (stepIndex >= calibrationSteps.length || frameSize.width === 0 || frameSize.height === 0) return;

    const { locationX, locationY } = event.nativeEvent;
    const normalizedX = locationX / frameSize.width;
    const normalizedY = locationY / frameSize.height;
    const point = {
      x: getUnzoomedCoordinate(normalizedX, zoomLevel),
      y: getUnzoomedCoordinate(normalizedY, zoomLevel)
    };
    const key = calibrationSteps[stepIndex].key;

    setPoints((current) => ({ ...current, [key]: point }));
    setStepIndex((current) => Math.min(current + 1, calibrationSteps.length));
  }

  function undoLastPoint() {
    const nextIndex = Math.max(0, Math.min(stepIndex, calibrationSteps.length) - 1);
    const key = calibrationSteps[nextIndex].key;
    setPoints((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setStepIndex(nextIndex);
  }

  function saveCalibration() {
    if (!geometry) return;
    onSave(geometry, selectedFrameTime);
  }

  function changeSelectedFrameTime(nextFrameTime: number) {
    const next = roundFrameTime(clamp(nextFrameTime, minFrameTime, maxFrameTime));
    if (next === selectedFrameTime) return;
    setSelectedFrameTime(next);
    setPoints({});
    setStepIndex(0);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.calibrationModalOverlay}>
        <Card style={styles.calibrationModalCard}>
          <View style={styles.modalTitleBlock}>
            <Chip tone={complete ? "green" : "amber"} icon={Crosshair}>
              {complete ? "Manual geometry" : `Step ${stepIndex + 1}/${calibrationSteps.length}`}
            </Chip>
            <Heading level={3}>{complete ? "Review calibration" : currentStep.label}</Heading>
            <AppText color={tokens.textMuted} size={13}>
              {complete ? "Save when the floor, tire baseline, torso, knee, and landing lines match the frame." : currentStep.detail}
            </AppText>
          </View>

          <View style={styles.frameChooserBlock}>
            <View style={styles.frameChooserHeader}>
              <AppText weight="bold" size={13}>
                Takeoff frame
              </AppText>
              <NumberText weight="bold" color={tokens.green} size={13}>
                {selectedFrameTime.toFixed(1)}s
              </NumberText>
            </View>
            <View style={styles.frameOptionRow}>
              {frameOptions.map((frameTime) => {
                const selected = frameTime === selectedFrameTime;
                return (
                  <Pressable
                    key={frameTime}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => changeSelectedFrameTime(frameTime)}
                    style={[styles.frameOption, selected && styles.frameOptionActive]}
                  >
                    <NumberText weight="bold" size={11} color={selected ? tokens.graphite : tokens.textMuted}>
                      {frameTime.toFixed(1)}s
                    </NumberText>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.frameStepperRow}>
              <Button variant="secondary" onPress={() => changeSelectedFrameTime(selectedFrameTime - 0.1)} style={styles.frameStepperButton}>
                -0.1s
              </Button>
              <Button variant="secondary" onPress={() => changeSelectedFrameTime(metric.frameTime)} style={styles.frameStepperButton}>
                Reset
              </Button>
              <Button variant="secondary" onPress={() => changeSelectedFrameTime(selectedFrameTime + 0.1)} style={styles.frameStepperButton}>
                +0.1s
              </Button>
            </View>
          </View>

          <View style={styles.zoomBlock}>
            <AppText weight="bold" size={13}>
              Zoom
            </AppText>
            <View style={styles.zoomOptionRow}>
              {zoomLevels.map((level) => {
                const selected = level === zoomLevel;
                return (
                  <Pressable
                    key={level}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setZoomLevel(level)}
                    style={[styles.zoomOption, selected && styles.zoomOptionActive]}
                  >
                    <NumberText weight="bold" size={11} color={selected ? tokens.graphite : tokens.textMuted}>
                      {level.toFixed(level % 1 === 0 ? 0 : 1)}x
                    </NumberText>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.manualCalibrationFrame}>
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { transform: [{ scale: zoomLevel }] }]}>
              <FrameMediaBackground
                key={`calibration-frame-${selectedFrameTime}`}
                mediaSource={mediaSource}
                frameTime={selectedFrameTime}
              />
              {geometry ? (
                <FrameGeometryOverlay metric={{ ...metric, frameTime: selectedFrameTime, geometry }} variant="large" showLabels />
              ) : null}
              {calibrationSteps.map((step, index) => {
                const point = points[step.key];
                if (!point) return null;

                return (
                  <View
                    key={step.key}
                    style={[
                      styles.calibrationMarker,
                      {
                        left: `${point.x * 100}%`,
                        top: `${point.y * 100}%`,
                        borderColor: step.color,
                        backgroundColor: index === stepIndex ? "rgba(9,13,15,0.94)" : "rgba(9,13,15,0.74)"
                      }
                    ]}
                  >
                    <NumberText weight="bold" size={9} color={step.color}>
                      {step.marker}
                    </NumberText>
                  </View>
                );
              })}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Manual calibration frame"
              onLayout={handleFrameLayout}
              onPress={handleFramePress}
              style={StyleSheet.absoluteFill}
            />
          </View>

          <View style={styles.calibrationPointStrip}>
            {calibrationSteps.map((step) => {
              const marked = Boolean(points[step.key]);
              return (
                <View key={step.key} style={[styles.calibrationPointPill, marked && styles.calibrationPointPillMarked]}>
                  <NumberText weight="bold" size={10} color={marked ? tokens.graphite : tokens.textMuted}>
                    {step.marker}
                  </NumberText>
                </View>
              );
            })}
          </View>

          <View style={styles.actionGrid}>
            <Button icon={Crosshair} onPress={saveCalibration} disabled={!geometry} style={styles.actionButton}>
              Save calibration
            </Button>
            <Button icon={RotateCcw} variant="secondary" onPress={undoLastPoint} disabled={stepIndex === 0} style={styles.actionButton}>
              Undo
            </Button>
          </View>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </Card>
      </View>
    </Modal>
  );
}

function buildFrameGeometry(points: CalibrationPoints): FrameGeometry | undefined {
  const floorStart = points.floorStart;
  const floorEnd = points.floorEnd;
  const rearTire = points.rearTire;
  const frontTire = points.frontTire;
  const hip = points.hip;
  const shoulder = points.shoulder;
  const knee = points.knee;
  const ankle = points.ankle;
  const landingStart = points.landingStart;
  const landingEnd = points.landingEnd;

  if (!floorStart || !floorEnd || !rearTire || !frontTire || !hip || !shoulder || !knee || !ankle || !landingStart || !landingEnd) {
    return undefined;
  }

  return {
    floor: { start: floorStart, end: floorEnd },
    tireBaseline: { start: rearTire, end: frontTire },
    torso: { start: hip, end: shoulder },
    kneeUpper: { start: hip, end: knee },
    kneeLower: { start: knee, end: ankle },
    landing: { start: landingStart, end: landingEnd }
  };
}

function getCalibrationPointsFromGeometry(geometry: FrameGeometry): CalibrationPoints {
  return {
    floorStart: geometry.floor.start,
    floorEnd: geometry.floor.end,
    rearTire: geometry.tireBaseline.start,
    frontTire: geometry.tireBaseline.end,
    hip: geometry.torso.start,
    shoulder: geometry.torso.end,
    knee: geometry.kneeUpper.end,
    ankle: geometry.kneeLower.end,
    landingStart: geometry.landing.start,
    landingEnd: geometry.landing.end
  };
}

function getTakeoffFrameOptions(centerFrameTime: number, minFrameTime: number, maxFrameTime: number): number[] {
  return [-0.4, -0.2, 0, 0.2, 0.4]
    .map((offset) => roundFrameTime(clamp(centerFrameTime + offset, minFrameTime, maxFrameTime)))
    .filter((frameTime, index, options) => options.indexOf(frameTime) === index);
}

function getUnzoomedCoordinate(normalizedCoordinate: number, zoomLevel: number): number {
  return clamp(0.5 + (normalizedCoordinate - 0.5) / zoomLevel, 0, 1);
}

function roundFrameTime(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  },
  content: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: 120
  },
  actionGrid: {
    flexDirection: "row",
    gap: spacing.md
  },
  actionButton: {
    flex: 1
  },
  cameraCard: {
    gap: spacing.lg
  },
  cameraFrame: {
    minHeight: 300,
    overflow: "hidden",
    borderRadius: 8,
    backgroundColor: tokens.graphite
  },
  cameraHud: {
    position: "absolute",
    top: spacing.md,
    right: spacing.md,
    left: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between"
  },
  linkInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 8,
    backgroundColor: tokens.surface,
    color: tokens.text,
    fontFamily: tokens.fontUi,
    fontSize: 15,
    paddingHorizontal: spacing.md
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(9, 13, 15, 0.54)",
    padding: spacing.lg
  },
  modalCard: {
    gap: spacing.lg
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md
  },
  modalTitleBlock: {
    gap: spacing.sm
  },
  modalBody: {
    lineHeight: 20
  },
  debugSampleButton: {
    alignSelf: "flex-start",
    minHeight: 40,
    paddingHorizontal: spacing.md
  },
  sourceList: {
    gap: spacing.sm
  },
  sourceOption: {
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 8,
    backgroundColor: tokens.surface,
    padding: spacing.md
  },
  sourceOptionPressed: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electricSoft
  },
  sourceIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: tokens.electricSoft
  },
  sourceText: {
    flex: 1,
    gap: 3
  },
  clipReviewCard: {
    gap: spacing.lg
  },
  trimSurface: {
    gap: spacing.sm
  },
  trimTrack: {
    height: 16,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: tokens.surfaceMuted
  },
  trimRange: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: 999,
    backgroundColor: tokens.green
  },
  trimTicks: {
    flexDirection: "row",
    justifyContent: "space-between"
  },
  trimGrid: {
    gap: spacing.md
  },
  trimControl: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  trimStepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  trimButton: {
    minWidth: 42,
    minHeight: 38,
    paddingHorizontal: 0
  },
  trimValue: {
    minWidth: 72,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: tokens.surfaceMuted,
    paddingVertical: spacing.xs
  },
  cropBlock: {
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.md
  },
  cropHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  cropGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm
  },
  cropPreset: {
    minHeight: 36,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 999,
    backgroundColor: tokens.surface,
    paddingHorizontal: spacing.md
  },
  cropPresetActive: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electric
  },
  clipNote: {
    borderLeftWidth: 4,
    borderLeftColor: tokens.cyan,
    borderRadius: 8,
    backgroundColor: "#fbfdfd",
    padding: spacing.md
  },
  scanCard: {
    padding: 0,
    overflow: "hidden"
  },
  scanSurface: {
    minHeight: 260,
    backgroundColor: tokens.graphite2,
    overflow: "hidden"
  },
  scanTop: {
    position: "absolute",
    zIndex: 2,
    top: spacing.md,
    right: spacing.md,
    left: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between"
  },
  scanBottom: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.md,
    left: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between"
  },
  calibrationPreviewOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg
  },
  calibrationPreviewPanel: {
    maxWidth: 310,
    alignItems: "center",
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: "rgba(182,255,46,0.36)",
    borderRadius: 8,
    backgroundColor: "rgba(9,13,15,0.76)",
    padding: spacing.lg
  },
  calibrationPreviewText: {
    textAlign: "center",
    lineHeight: 18
  },
  calibrationSummary: {
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
    backgroundColor: tokens.graphite,
    padding: spacing.lg
  },
  calibrationActionRow: {
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.1)",
    backgroundColor: tokens.graphite,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md
  },
  calibrationButton: {
    marginTop: spacing.md
  },
  calibrationModalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(9, 13, 15, 0.62)",
    padding: spacing.md
  },
  calibrationModalCard: {
    maxHeight: "94%",
    gap: spacing.lg
  },
  frameChooserBlock: {
    gap: spacing.sm
  },
  frameChooserHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  frameOptionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs
  },
  frameOption: {
    minHeight: 32,
    minWidth: 54,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 999,
    backgroundColor: tokens.surfaceMuted,
    paddingHorizontal: spacing.sm
  },
  frameOptionActive: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electric
  },
  frameStepperRow: {
    flexDirection: "row",
    gap: spacing.sm
  },
  frameStepperButton: {
    flex: 1,
    minHeight: 38,
    paddingHorizontal: spacing.sm
  },
  zoomBlock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  zoomOptionRow: {
    flexDirection: "row",
    gap: spacing.xs
  },
  zoomOption: {
    minHeight: 32,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 999,
    backgroundColor: tokens.surfaceMuted
  },
  zoomOptionActive: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electric
  },
  manualCalibrationFrame: {
    height: 320,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(182,255,46,0.32)",
    borderRadius: 8,
    backgroundColor: tokens.graphite2
  },
  calibrationMarker: {
    position: "absolute",
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -14,
    marginTop: -14,
    borderWidth: 2,
    borderRadius: 999
  },
  calibrationPointStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs
  },
  calibrationPointPill: {
    minWidth: 30,
    minHeight: 28,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 999,
    backgroundColor: tokens.surfaceMuted
  },
  calibrationPointPillMarked: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electric
  },
  targetRing: {
    position: "absolute",
    left: "50%",
    top: "48%",
    width: 174,
    height: 174,
    marginLeft: -87,
    marginTop: -87,
    borderWidth: 2,
    borderColor: "rgba(182,255,46,0.42)",
    borderRadius: 999
  },
  wheel: {
    position: "absolute",
    width: 38,
    height: 38,
    borderWidth: 4,
    borderColor: tokens.surface,
    borderRadius: 999
  },
  wheelOne: {
    left: 76,
    top: 134
  },
  wheelTwo: {
    left: 204,
    top: 120
  },
  bikeLine: {
    position: "absolute",
    left: 86,
    top: 121,
    width: 166,
    height: 4,
    borderRadius: 999,
    backgroundColor: tokens.electric,
    transform: [{ rotate: "8deg" }]
  },
  poseLine: {
    position: "absolute",
    zIndex: 1,
    borderRadius: 999,
    backgroundColor: tokens.cyan
  },
  poseBack: {
    left: 158,
    top: 76,
    width: 4,
    height: 74,
    transform: [{ rotate: "-18deg" }]
  },
  poseArm: {
    left: 168,
    top: 95,
    width: 58,
    height: 4,
    transform: [{ rotate: "17deg" }]
  },
  poseLeg: {
    left: 144,
    top: 141,
    width: 64,
    height: 4,
    transform: [{ rotate: "-31deg" }]
  },
  rampLine: {
    position: "absolute",
    right: 26,
    bottom: 58,
    width: 164,
    height: 42,
    borderBottomWidth: 5,
    borderBottomColor: "rgba(255,255,255,0.78)",
    transform: [{ rotate: "-12deg" }]
  },
  metricGrid: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  progressTrack: {
    height: 8,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: tokens.surfaceMuted,
    marginTop: spacing.lg
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: tokens.green
  },
  progressLabel: {
    alignItems: "flex-end",
    marginTop: spacing.xs
  },
  smallButton: {
    minHeight: 38,
    paddingHorizontal: spacing.md
  },
  reportTitle: {
    marginTop: spacing.lg
  },
  reportText: {
    lineHeight: 21,
    marginTop: spacing.sm
  },
  reportList: {
    gap: spacing.sm,
    marginTop: spacing.md
  },
  bulletRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start"
  },
  bullet: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: tokens.green,
    marginTop: 7
  },
  warningCard: {
    borderColor: "#f2c068",
    backgroundColor: tokens.amberSoft
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xs
  }
});
