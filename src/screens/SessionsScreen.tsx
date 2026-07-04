import { FileVideo } from "lucide-react-native";
import { ScrollView, StyleSheet, View } from "react-native";

import { RecordCard } from "../components/RecordCard";
import { AppText, BrandHeader, Button, Card, Chip, NumberText, SectionHeader } from "../components/ui";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { getSkillLabel } from "../services/analysis";
import { spacing, tokens } from "../theme/tokens";
import type { JumpRecord } from "../types/domain";

type SessionsScreenProps = {
  store: RiderLensStore;
};

export function SessionsScreen({ store }: SessionsScreenProps) {
  const active = store.activeRecord;

  return (
    <View style={styles.root}>
      <BrandHeader subtitle="History" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionHeader
          eyebrow="History"
          title="Your captured moments"
          body="Every record keeps the trimmed clip, the key frames with your body position, and the timeline."
        />

        <View style={styles.recordList}>
          {store.records.length === 0 ? (
            <Card style={styles.emptyCard}>
              <View style={styles.emptyIcon}>
                <FileVideo color={tokens.green} size={20} />
              </View>
              <View style={styles.emptyText}>
                <AppText weight="bold">No records yet</AppText>
                <AppText color={tokens.textMuted} size={13}>
                  Capture a jump from the Capture tab to start your history.
                </AppText>
              </View>
            </Card>
          ) : (
            store.records.map((record) => (
              <RecordRow
                key={record.id}
                record={record}
                active={record.id === active?.id}
                onPress={() => store.selectRecord(record.id)}
              />
            ))
          )}
        </View>

        {active ? (
          <RecordCard
            record={active}
            onShare={store.shareRecordClip}
            onRetry={(record) => store.retryRecord(record.id)}
            onDelete={(record) => store.deleteRecord(record.id)}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function RecordRow({ record, active, onPress }: { record: JumpRecord; active: boolean; onPress: () => void }) {
  const tone = record.status === "ready" ? "green" : record.status === "failed" ? "red" : "amber";
  const label = record.status === "ready" ? "ready" : record.status === "processing" ? "processing" : record.status;

  return (
    <Card style={[styles.recordRow, active && styles.recordRowActive]}>
      <View style={styles.recordHeader}>
        <View style={styles.recordIcon}>
          <FileVideo color={active ? tokens.graphite : tokens.green} size={18} strokeWidth={2.4} />
        </View>
        <View style={styles.recordText}>
          <AppText weight="bold">{getSkillLabel(record.skillType)}</AppText>
          <AppText color={tokens.textMuted} size={12}>
            {new Date(record.createdAt).toLocaleDateString()} ·{" "}
            <NumberText size={12} color={tokens.textMuted}>
              {(record.windowEnd - record.windowStart).toFixed(1)}s
            </NumberText>
            {record.eventType ? ` · ${record.eventType.replace(/_/g, " ")}` : ""}
          </AppText>
        </View>
        <Chip tone={tone}>{label}</Chip>
      </View>
      <Button variant={active ? "dark" : "secondary"} onPress={onPress} style={styles.reviewButton}>
        {active ? "Selected" : "Review"}
      </Button>
    </Card>
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
  recordList: {
    gap: spacing.md
  },
  emptyCard: {
    minHeight: 112,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  emptyIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: tokens.electricSoft
  },
  emptyText: {
    flex: 1,
    gap: 3
  },
  recordRow: {
    gap: spacing.md
  },
  recordRowActive: {
    borderColor: tokens.electric
  },
  recordHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  recordIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: tokens.electricSoft
  },
  recordText: {
    flex: 1
  },
  reviewButton: {
    minHeight: 40
  }
});
