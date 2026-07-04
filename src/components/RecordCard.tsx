import { useVideoPlayer, VideoView } from "expo-video";
import { AlertTriangle, RefreshCcw, Share2, Trash2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, View } from "react-native";

import { loadRecordDetail } from "../services/recordStore";
import { getSkillLabel } from "../services/analysis";
import { spacing, tokens } from "../theme/tokens";
import type { JumpRecord, JumpRecordDetail } from "../types/domain";
import { AnalysisFrames } from "./AnalysisFrames";
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

export function RecordCard({ record, onShare, onRetry, onDelete }: RecordCardProps) {
  const [detail, setDetail] = useState<JumpRecordDetail | undefined>();

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
          <AnalysisFrames metrics={detail.metrics} emptyText="No key frames in this record." />
          {detail.filmstrip.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filmstrip}>
              {detail.filmstrip.map((frame) => (
                <View key={frame.t} style={styles.filmstripCell}>
                  <Image source={{ uri: frame.image }} style={styles.filmstripImage} />
                  <NumberText size={10} color={tokens.textMuted}>
                    {frame.t.toFixed(2)}s
                  </NumberText>
                </View>
              ))}
            </ScrollView>
          ) : null}
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
    width: 120,
    height: 68,
    borderRadius: 6,
    backgroundColor: tokens.graphite
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
  }
});
