import { CameraView, useCameraPermissions } from "expo-camera";
import * as VideoThumbnails from "expo-video-thumbnails";
import { AlertTriangle, Camera, CheckCircle2, Clock3, FileVideo, Scissors, Sparkles, Upload } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Image, ScrollView, StyleSheet, View } from "react-native";

import { RecordCard } from "../components/RecordCard";
import { AppText, BrandHeader, Button, Card, Chip, NumberText, SectionHeader } from "../components/ui";
import type { PendingCapture, RiderLensStore } from "../hooks/useRiderLensMvp";
import { spacing, tokens } from "../theme/tokens";

type CoachScreenProps = {
  store: RiderLensStore;
};

export function CoachScreen({ store }: CoachScreenProps) {
  const [cameraOpen, setCameraOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const latestRecord = store.records[0];

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
      const video = await cameraRef.current.recordAsync({ maxDuration: 30 });
      if (video?.uri) {
        store.startCaptureFromUri(video.uri, 30);
      }
      setCameraOpen(false);
    } finally {
      setRecording(false);
    }
  }

  function stopRecording() {
    cameraRef.current?.stopRecording?.();
  }

  return (
    <View style={styles.root}>
      <BrandHeader subtitle="Capture" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionHeader
          eyebrow="Capture"
          title="Record the moment"
          body="Film or pick a clip. RiderLens finds your jump, cuts it out, and draws your body position on every frame."
        />

        <View style={styles.actionGrid}>
          <Button icon={Camera} onPress={openCamera} style={styles.actionButton}>
            Record
          </Button>
          <Button icon={Upload} variant="secondary" onPress={() => store.uploadVideoFromLibrary()} style={styles.actionButton}>
            Library
          </Button>
        </View>

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
                    30s
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

        {store.pendingCapture ? <WindowStep store={store} capture={store.pendingCapture} /> : null}

        {!store.pendingCapture && latestRecord ? (
          <RecordCard
            record={latestRecord}
            onShare={store.shareRecordClip}
            onRetry={(record) => store.retryRecord(record.id)}
            onDelete={(record) => store.deleteRecord(record.id)}
          />
        ) : null}

        <Card style={styles.warningCard}>
          <View style={styles.warningHeader}>
            <AlertTriangle color="#7a4b00" size={18} />
            <AppText weight="bold" color="#704400">
              Ride within your limits
            </AppText>
          </View>
          <AppText size={13} color="#704400">
            RiderLens captures what happened — it does not make a jump safe. Practice within your ability and wear protective
            gear.
          </AppText>
        </Card>
      </ScrollView>
    </View>
  );
}

// --- Window step: confirm where the moment is ---------------------------------

const THUMBNAIL_COUNT = 8;

function WindowStep({ store, capture }: { store: RiderLensStore; capture: PendingCapture }) {
  const [thumbnails, setThumbnails] = useState<Array<{ t: number; uri: string }>>([]);
  const windowSeconds = Math.max(0, capture.trimEndSeconds - capture.trimStartSeconds);

  useEffect(() => {
    let active = true;
    setThumbnails([]);
    const duration = capture.durationSeconds;
    const times = Array.from({ length: THUMBNAIL_COUNT }, (_, index) => (duration * (index + 0.5)) / THUMBNAIL_COUNT);
    void Promise.all(
      times.map(async (t) => {
        try {
          const result = await VideoThumbnails.getThumbnailAsync(capture.uri, { time: Math.round(t * 1000), quality: 0.4 });
          return { t, uri: result.uri };
        } catch {
          return undefined;
        }
      })
    ).then((generated) => {
      if (active) setThumbnails(generated.filter(Boolean) as Array<{ t: number; uri: string }>);
    });
    return () => {
      active = false;
    };
    // Thumbnails depend only on the source clip, not on the trim values.
  }, [capture.uri, capture.durationSeconds]);

  const statusLine =
    capture.windowStatus === "checking"
      ? "Looking for your jump…"
      : capture.windowStatus === "ai"
        ? "AI found your jump — adjust if needed."
        : "Set the window around your jump.";

  return (
    <Card style={styles.windowCard}>
      <View style={styles.splitRow}>
        <Chip tone={capture.windowStatus === "ai" ? "cyan" : "neutral"} icon={capture.windowStatus === "ai" ? Sparkles : Scissors}>
          {capture.windowStatus === "ai" ? "AI window" : "Window"}
        </Chip>
        <NumberText color={tokens.textMuted} size={12} weight="bold">
          {windowSeconds.toFixed(1)}s selected
        </NumberText>
      </View>
      <AppText color={tokens.textMuted} size={13}>
        {statusLine}
      </AppText>

      {capture.proposal?.summary ? (
        <AppText color={tokens.textMuted} size={13}>
          {capture.proposal.summary}
        </AppText>
      ) : null}

      {thumbnails.length > 0 ? (
        <View style={styles.thumbnailRow}>
          {thumbnails.map((thumbnail) => {
            const inWindow = thumbnail.t >= capture.trimStartSeconds && thumbnail.t <= capture.trimEndSeconds;
            return (
              <View key={thumbnail.t} style={[styles.thumbnailCell, !inWindow && styles.thumbnailOutside]}>
                <Image source={{ uri: thumbnail.uri }} style={styles.thumbnailImage} />
              </View>
            );
          })}
        </View>
      ) : null}

      <WindowControl
        label="Start"
        value={capture.trimStartSeconds}
        onChange={(value) => store.updatePendingWindow({ trimStartSeconds: value })}
      />
      <WindowControl
        label="End"
        value={capture.trimEndSeconds}
        onChange={(value) => store.updatePendingWindow({ trimEndSeconds: value })}
      />

      <View style={styles.actionGrid}>
        <Button onPress={() => store.confirmPendingCapture()} style={styles.actionButton}>
          Create record
        </Button>
        <Button variant="secondary" onPress={store.cancelPendingCapture} style={styles.actionButton}>
          Cancel
        </Button>
      </View>
    </Card>
  );
}

function WindowControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <View style={styles.windowControl}>
      <AppText weight="semi" size={13} style={styles.windowControlLabel}>
        {label}
      </AppText>
      <View style={styles.stepper}>
        <Button variant="secondary" onPress={() => onChange(Math.max(0, value - 0.5))} style={styles.stepButton}>
          −
        </Button>
        <View style={styles.stepValue}>
          <NumberText weight="bold">{value.toFixed(1)}s</NumberText>
        </View>
        <Button variant="secondary" onPress={() => onChange(value + 0.5)} style={styles.stepButton}>
          +
        </Button>
      </View>
    </View>
  );
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
    gap: spacing.md
  },
  cameraFrame: {
    height: 260,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: tokens.graphite
  },
  cameraHud: {
    position: "absolute",
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between"
  },
  windowCard: {
    gap: spacing.md
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  thumbnailRow: {
    flexDirection: "row",
    gap: 4
  },
  thumbnailCell: {
    flex: 1,
    borderRadius: 4,
    overflow: "hidden"
  },
  thumbnailOutside: {
    opacity: 0.3
  },
  thumbnailImage: {
    width: "100%",
    height: 44,
    backgroundColor: tokens.graphite
  },
  windowControl: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  windowControlLabel: {
    width: 48
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  stepButton: {
    minWidth: 44,
    minHeight: 38,
    paddingHorizontal: 0
  },
  stepValue: {
    minWidth: 76,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: tokens.surfaceMuted,
    paddingVertical: spacing.xs
  },
  warningCard: {
    backgroundColor: tokens.amberSoft,
    borderColor: "#f2c068",
    gap: spacing.sm
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  }
});
