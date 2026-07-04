import Slider from "@react-native-community/slider";
import { useVideoPlayer, VideoView } from "expo-video";
import { AlertTriangle, Pause, Play, RefreshCcw, Share2, Trash2, X } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { getSkillLabel } from "../services/analysis";
import { loadRecordDetail } from "../services/recordStore";
import { spacing, tokens } from "../theme/tokens";
import type { FilmstripFrame, JumpRecord, JumpRecordDetail } from "../types/domain";
import { TimelineChart } from "./TimelineChart";
import { AppText, Button, Card, Chip, NumberText } from "./ui";

type RecordCardProps = {
  record: JumpRecord;
  onShare?: (record: JumpRecord) => void;
  onRetry?: (record: JumpRecord) => void;
  onDelete?: (record: JumpRecord) => void;
};

function ClipPlayer({ clipUri }: { clipUri: string }) {
  const player = useVideoPlayer(clipUri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });
  return <VideoView player={player} style={styles.player} contentFit="contain" nativeControls />;
}

/** Label each event with the closest filmstrip frame so tags render on the strip. */
function eventLabels(record: JumpRecord, filmstrip: FilmstripFrame[]): Map<number, string> {
  const labels = new Map<number, string>();
  for (const event of record.events ?? []) {
    let bestIndex = -1;
    let bestDistance = 0.25;
    filmstrip.forEach((frame, index) => {
      const distance = Math.abs(frame.t - event.time_seconds);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && !labels.has(bestIndex)) {
      labels.set(bestIndex, event.name.replace(/_/g, " "));
    }
  }
  return labels;
}

// Playback runs at half speed: slow enough to read body position, fast enough to feel motion.
const PLAYBACK_SPEED = 0.5;

export function RecordCard({ record, onShare, onRetry, onDelete }: RecordCardProps) {
  const [detail, setDetail] = useState<JumpRecordDetail | undefined>();
  const [zoomed, setZoomed] = useState<FilmstripFrame | undefined>();
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setFrameIndex(0);
    setPlaying(false);
    if (record.status === "ready") {
      loadRecordDetail(record.id).then((loaded) => {
        if (active) setDetail(loaded);
      });
    }
    return () => {
      active = false;
    };
  }, [record.id, record.status]);

  const frames = detail?.filmstrip ?? [];
  const labels = useMemo(() => (detail ? eventLabels(record, detail.filmstrip) : new Map<number, string>()), [detail, record]);

  const frameIntervalMs = useMemo(() => {
    if (frames.length < 2) return 120;
    const realInterval = ((frames[frames.length - 1].t - frames[0].t) / (frames.length - 1)) * 1000;
    return Math.max(40, realInterval / PLAYBACK_SPEED);
  }, [frames]);

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % frames.length);
    }, frameIntervalMs);
    return () => clearInterval(timer);
  }, [frames.length, frameIntervalMs, playing]);

  const currentFrame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))];

  const statusTone = record.status === "ready" ? "green" : record.status === "failed" ? "red" : "amber";
  const statusLabel =
    record.status === "ready"
      ? "Ready"
      : record.status === "processing"
        ? "Processing"
        : record.status === "failed"
          ? "Failed"
          : "Waiting for connection";

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <AppText weight="bold">{getSkillLabel(record.skillType)}</AppText>
          <AppText color={tokens.textMuted} size={12}>
            {new Date(record.createdAt).toLocaleString()} ·{" "}
            <NumberText size={12} color={tokens.textMuted}>
              {record.windowStart.toFixed(1)}s–{record.windowEnd.toFixed(1)}s
            </NumberText>
            {record.aiWindow ? " · AI window" : " · manual window"}
          </AppText>
        </View>
        <Chip tone={statusTone}>{statusLabel}</Chip>
      </View>

      {record.summary ? (
        <AppText color={tokens.textMuted} size={13}>
          {record.summary}
        </AppText>
      ) : null}

      {record.status === "ready" && record.clipUri ? <ClipPlayer clipUri={record.clipUri} /> : null}

      {record.status === "ready" && detail && currentFrame ? (
        <>
          {/* Sequence player: frame-by-frame with the skeleton. Tap the frame to zoom. */}
          <View>
            <Pressable onPress={() => setZoomed(currentFrame)}>
              <Image source={{ uri: currentFrame.image }} style={styles.sequenceFrame} resizeMode="contain" />
              {labels.has(frameIndex) ? (
                <View style={styles.eventTagLarge}>
                  <AppText size={11} weight="bold" color={tokens.graphite}>
                    {labels.get(frameIndex)}
                  </AppText>
                </View>
              ) : null}
            </Pressable>
            <View style={styles.playerControls}>
              <Button
                icon={playing ? Pause : Play}
                variant="secondary"
                onPress={() => setPlaying((value) => !value)}
                style={styles.playButton}
              >
                {playing ? "Pause" : "Play"}
              </Button>
              <Slider
                style={styles.slider}
                minimumValue={0}
                maximumValue={Math.max(0, frames.length - 1)}
                step={1}
                value={frameIndex}
                minimumTrackTintColor={tokens.electric}
                maximumTrackTintColor={tokens.border}
                thumbTintColor={tokens.electric}
                onValueChange={(value) => {
                  setPlaying(false);
                  setFrameIndex(Math.round(value));
                }}
              />
              <NumberText size={12} color={tokens.textMuted} style={styles.playerTime}>
                {currentFrame.t.toFixed(2)}s
              </NumberText>
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filmstrip}>
            {frames.map((frame, index) => (
              <Pressable
                key={frame.t}
                onPress={() => {
                  setPlaying(false);
                  setFrameIndex(index);
                }}
                style={styles.filmstripCell}
              >
                <Image
                  source={{ uri: frame.image }}
                  style={[styles.filmstripImage, index === frameIndex && styles.filmstripImageActive]}
                />
                {labels.has(index) ? (
                  <View style={styles.eventTag}>
                    <AppText size={10} weight="bold" color={tokens.graphite}>
                      {labels.get(index)}
                    </AppText>
                  </View>
                ) : null}
                <NumberText size={10} color={tokens.textMuted}>
                  {frame.t.toFixed(2)}s
                </NumberText>
              </Pressable>
            ))}
          </ScrollView>
          <TimelineChart series={detail.series} events={record.events} />
        </>
      ) : null}

      {record.status === "pending" || record.status === "failed" ? (
        <View style={styles.pendingRow}>
          <AlertTriangle color={tokens.amber} size={16} />
          <AppText size={13} color={tokens.textMuted} style={styles.pendingText}>
            {record.error ?? "This record has not been processed yet."}
          </AppText>
        </View>
      ) : null}

      <View style={styles.actions}>
        {record.status === "ready" && onShare ? (
          <Button icon={Share2} variant="secondary" onPress={() => onShare(record)} style={styles.actionButton}>
            Share clip
          </Button>
        ) : null}
        {(record.status === "pending" || record.status === "failed") && onRetry ? (
          <Button icon={RefreshCcw} onPress={() => onRetry(record)} style={styles.actionButton}>
            Retry
          </Button>
        ) : null}
        {onDelete ? (
          <Button icon={Trash2} variant="secondary" onPress={() => onDelete(record)} style={styles.actionButton}>
            Delete
          </Button>
        ) : null}
      </View>

      <Modal visible={Boolean(zoomed)} transparent animationType="fade" onRequestClose={() => setZoomed(undefined)}>
        <Pressable style={styles.zoomOverlay} onPress={() => setZoomed(undefined)}>
          {zoomed ? (
            <View style={styles.zoomContent}>
              <Image source={{ uri: zoomed.image }} style={styles.zoomImage} resizeMode="contain" />
              <View style={styles.zoomCaption}>
                <NumberText color={tokens.surface} weight="bold">
                  {zoomed.t.toFixed(2)}s
                </NumberText>
                <X color={tokens.surface} size={18} />
              </View>
            </View>
          ) : null}
        </Pressable>
      </Modal>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  headerText: {
    flex: 1
  },
  player: {
    width: "100%",
    height: 210,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: tokens.graphite
  },
  sequenceFrame: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: 10,
    backgroundColor: tokens.graphite
  },
  eventTagLarge: {
    position: "absolute",
    top: 10,
    left: 10,
    backgroundColor: tokens.electric,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3
  },
  playerControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm
  },
  playButton: {
    minHeight: 40,
    minWidth: 96,
    paddingHorizontal: spacing.md
  },
  slider: {
    flex: 1,
    height: 36
  },
  playerTime: {
    minWidth: 48,
    textAlign: "right"
  },
  filmstrip: {
    gap: spacing.sm
  },
  filmstripCell: {
    alignItems: "center",
    gap: 2
  },
  filmstripImage: {
    width: 132,
    height: 74,
    borderRadius: 6,
    backgroundColor: tokens.graphite,
    borderWidth: 2,
    borderColor: "transparent"
  },
  filmstripImageActive: {
    borderColor: tokens.electric
  },
  eventTag: {
    position: "absolute",
    top: 6,
    left: 6,
    backgroundColor: tokens.electric,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  pendingText: {
    flex: 1
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md
  },
  actionButton: {
    flex: 1,
    minHeight: 42
  },
  zoomOverlay: {
    flex: 1,
    backgroundColor: "rgba(9, 13, 15, 0.92)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg
  },
  zoomContent: {
    width: "100%",
    gap: spacing.sm
  },
  zoomImage: {
    width: "100%",
    height: 340,
    borderRadius: 10
  },
  zoomCaption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  }
});
