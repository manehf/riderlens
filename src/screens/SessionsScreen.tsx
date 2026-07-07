import { FileVideo, Settings, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { RecordCard } from "../components/RecordCard";
import { SettingsSheet } from "./SettingsSheet";
import { AppText, BrandHeader, Card, Chip, DisplayText, NumberText } from "../components/ui";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { getRecordTitle, getSystemTags } from "../services/analysis";
import { radius, spacing, tokens } from "../theme/tokens";
import type { JumpRecord } from "../types/domain";

type SessionsScreenProps = {
  store: RiderLensStore;
};

// One active tag filter at a time. Records are phone-scale (tens, not
// thousands), so chips beat a search box — no keyboard on the trail.
function recordTags(record: JumpRecord): string[] {
  return [...getSystemTags(record), ...(record.tags ?? [])];
}

function matchesFilter(record: JumpRecord, filter: string | undefined): boolean {
  if (!filter) return true;
  return recordTags(record).some((tag) => tag.toLowerCase() === filter.toLowerCase());
}

export function SessionsScreen({ store }: SessionsScreenProps) {
  const [filter, setFilter] = useState<string | undefined>();
  // The library is just the grid; a tapped record opens in a full-screen sheet.
  const [openRecordId, setOpenRecordId] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const tags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const record of store.records) {
      for (const tag of recordTags(record)) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
    return [...seen.values()];
  }, [store.records]);

  const filtered = useMemo(
    () => store.records.filter((record) => matchesFilter(record, filter)),
    [filter, store.records]
  );

  const openRecord = store.records.find((record) => record.id === openRecordId);
  const showFilters = tags.length > 0;

  return (
    <View style={styles.root}>
      <BrandHeader
        action={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => setSettingsOpen(true)}
            style={styles.settingsButton}
          >
            <Settings color={tokens.text} size={20} strokeWidth={2.2} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.intro}>
          <DisplayText size={34} style={styles.introTitle}>
            YOUR PROGRESSION
          </DisplayText>
          <AppText color={tokens.textMuted} size={13} style={styles.introBody}>
            Every send, trimmed to the action with your body position on every frame. Study it, dial it in.
          </AppText>
        </View>

        {showFilters ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
            <FilterChip label="All" active={!filter} onPress={() => setFilter(undefined)} />
            {tags.map((tag) => (
              <FilterChip
                key={`tag-${tag}`}
                label={`# ${tag}`}
                active={filter === tag}
                onPress={() => setFilter(tag)}
              />
            ))}
          </ScrollView>
        ) : null}

        {store.records.length === 0 ? (
          <Card style={styles.emptyCard}>
            <View style={styles.emptyIcon}>
              <FileVideo color={tokens.green} size={20} />
            </View>
            <View style={styles.emptyText}>
              <AppText weight="bold">No records yet</AppText>
              <AppText color={tokens.textMuted} size={13}>
                Tap the + button to capture your first moment.
              </AppText>
            </View>
          </Card>
        ) : (
          <View style={styles.grid}>
            {filtered.map((record) => (
              <PosterCell key={record.id} record={record} onPress={() => setOpenRecordId(record.id)} />
            ))}
            {filtered.length === 0 ? (
              <AppText color={tokens.textMuted} size={13}>
                No records match this filter.
              </AppText>
            ) : null}
          </View>
        )}
      </ScrollView>

      <Modal
        visible={Boolean(openRecord)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpenRecordId(undefined)}
      >
        {openRecord ? (
          <View style={styles.sheetRoot}>
            <View style={styles.sheetHeader}>
              <AppText weight="bold" size={17}>
                {getRecordTitle(openRecord)}
              </AppText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close record"
                onPress={() => setOpenRecordId(undefined)}
                style={styles.sheetClose}
              >
                <X color={tokens.text} size={20} strokeWidth={2.4} />
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              automaticallyAdjustKeyboardInsets
            >
              <RecordCard
                record={openRecord}
                onShare={store.shareRecordClip}
                onRetry={(record) => store.retryRecord(record.id)}
                onDelete={(record) => {
                  setOpenRecordId(undefined);
                  store.deleteRecord(record.id);
                }}
                onAddTag={store.addRecordTag}
                onRemoveTag={store.removeRecordTag}
                tagSuggestions={store.knownTags}
              />
            </ScrollView>
          </View>
        ) : null}
      </Modal>

      <SettingsSheet store={store} visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </View>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.filterChip, active && styles.filterChipActive]}
    >
      <AppText size={12} weight="bold" color={active ? tokens.electric : tokens.textMuted}>
        {label}
      </AppText>
    </Pressable>
  );
}

function PosterCell({ record, onPress }: { record: JumpRecord; onPress: () => void }) {
  const tags = recordTags(record);
  const durationSeconds = record.windowEnd - record.windowStart;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review ${getRecordTitle(record)} record`}
      onPress={onPress}
      style={styles.cell}
    >
      <View style={styles.poster}>
        {record.posterUri ? (
          <Image source={{ uri: record.posterUri }} style={styles.posterImage} resizeMode="cover" />
        ) : (
          <View style={styles.posterPlaceholder}>
            <FileVideo color={tokens.textMuted} size={22} />
          </View>
        )}
        {record.status !== "ready" ? (
          <View style={styles.posterStatus}>
            <Chip tone={record.status === "failed" ? "red" : "amber"}>
              {record.status === "processing" ? "Processing" : record.status === "failed" ? "Failed" : "Queued"}
            </Chip>
          </View>
        ) : null}
      </View>
      <View style={styles.cellBody}>
        <AppText weight="bold" size={13}>
          {getRecordTitle(record)}
        </AppText>
        <NumberText size={11} color={tokens.textMuted}>
          {durationSeconds.toFixed(1)}s
        </NumberText>
        {tags.length > 0 ? (
          <AppText color={tokens.green} size={11} weight="semi" numberOfLines={1}>
            {tags.map((tag) => `# ${tag}`).join("  ")}
          </AppText>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  },
  settingsButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: tokens.surfaceMuted
  },
  content: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: 120
  },
  intro: {
    gap: spacing.xs
  },
  introTitle: {
    lineHeight: 36
  },
  introBody: {
    lineHeight: 18
  },
  filterRow: {
    gap: spacing.sm
  },
  filterChip: {
    minHeight: 30,
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 12
  },
  filterChipActive: {
    backgroundColor: tokens.graphite,
    borderColor: tokens.graphite
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
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md
  },
  cell: {
    // Two columns: half the row minus half the gap.
    flexBasis: "47%",
    flexGrow: 1,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    overflow: "hidden"
  },
  poster: {
    width: "100%",
    aspectRatio: 16 / 10,
    backgroundColor: tokens.graphite
  },
  posterImage: {
    width: "100%",
    height: "100%"
  },
  posterPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.surfaceMuted
  },
  posterStatus: {
    position: "absolute",
    top: 6,
    right: 6
  },
  cellBody: {
    gap: 2,
    padding: spacing.sm
  },
  sheetRoot: {
    flex: 1,
    backgroundColor: tokens.background
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md
  },
  sheetClose: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: tokens.surfaceMuted
  },
  sheetContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  }
});
