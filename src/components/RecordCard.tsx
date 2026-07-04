import { useVideoPlayer, VideoView } from "expo-video";
import { AlertTriangle, RefreshCcw, Share2, Trash2, X } from "lucide-react-native";
import { useEffect, useState } from "react";
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
    let bestDistance = Number.POSITIVE_INFINITY;
    filmstrip.forEach((frame, index) => {
      const distance = Math.abs(frame.t - event.time_seconds);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestDistance <= 0.25 && !labels.has(bestIndex)) {
      labels.set(bestIndex, event.name.replace(/_/g, " "));
    }
  }
  return labels;
}

export function RecordCard({ record, onShare, onRetry, onDelete }: RecordCardProps) {
  const [detail, setDetail] = useState<JumpRecordDetail | undefined>();
  const [zoomed, setZoomed] = useState<FilmstripFrame | undefined>();

  useEffect(() => {
    let active = true;
    setDetail(undefined);
    if (record.status === "ready") {
      loadRecordDetail(record.id).then((loaded) => {
        if (active) setDetail(loaded);
      });
    }
    return () => {
      active = false;
    };
  }, [record.id, record.status]);

  const statusTone = record.status === "ready" ? "green" : record.status === "failed" ? "red" : "amber";
  const statusLabel =
    record.status === "ready"
      ? "Ready"
      : record.status === "processing"
        ? "Processing"
        : record.status === "failed"
          ? "Failed"
          : "Waiting for connection";
  const labels = detail ? eventLabels(record, detail.filmstrip) : new Map<number, string>();

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

      {record.status === "ready" && detail ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filmstrip}>
            {detail.filmstrip.map((frame, index) => (
              <Pressable key={frame.t} onPress={() => setZoomed(frame)} style={styles.filmstripCell}>
                <Image source={{ uri: frame.image }} style={styles.filmstripImage} />
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
  filmstrip: {
    gap: spacing.sm
  },
  filmstripCell: {
    alignItems: "center",
    gap: 2
  },
  filmstripImage: {
    width: 168,
    height: 95,
    borderRadius: 6,
    backgroundColor: tokens.graphite
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
    height: 320,
    borderRadius: 10
  },
  zoomCaption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  }
});
