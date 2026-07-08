import * as VideoThumbnails from "expo-video-thumbnails";
import { AlertTriangle, RotateCw, Scissors, Sparkles, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText, Button, Card, Chip, DisplayText, NumberText } from "../components/ui";
import type { PendingCapture, RiderLensStore } from "../hooks/useRiderLensMvp";
import { radius, spacing, tokens } from "../theme/tokens";

type CaptureSheetProps = {
  store: RiderLensStore;
  visible: boolean;
  onClose: () => void;
};

/** The trim step as a modal over the library. Filming and picking happen in
 * native UIs (system camera / photo picker); this sheet opens once a clip
 * exists, to confirm the window and create the record. */
export function CaptureSheet({ store, visible, onClose }: CaptureSheetProps) {
  const reprocessing = Boolean(store.pendingCapture?.reprocessRecordId);

  function close() {
    store.cancelPendingCapture();
    onClose();
  }

  async function confirmCapture() {
    await store.confirmPendingCapture();
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.sheetRoot}>
        <View style={styles.sheetHeader}>
          <View style={styles.sheetHeaderText}>
            <DisplayText size={24}>{reprocessing ? "REPROCESS" : "TRIM THE MOMENT"}</DisplayText>
            <AppText color={tokens.textMuted} size={12}>
              {reprocessing
                ? "Rotate or re-trim — the record is rebuilt from the original video."
                : "Set the window around the action — RiderLens does the rest."}
            </AppText>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close capture" onPress={close} style={styles.sheetClose}>
            <X color={tokens.text} size={20} strokeWidth={2.4} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {store.pendingCapture ? (
            <WindowStep store={store} capture={store.pendingCapture} onConfirm={confirmCapture} />
          ) : null}

          <Card style={styles.warningCard}>
            <View style={styles.warningHeader}>
              <AlertTriangle color="#7a4b00" size={18} />
              <AppText weight="bold" color="#704400">
                Ride within your limits
              </AppText>
            </View>
            <AppText size={13} color="#704400">
              RiderLens captures what happened — it does not make a jump safe. Practice within your ability and wear
              protective gear.
            </AppText>
          </Card>
        </ScrollView>
      </View>
    </Modal>
  );
}

// --- Window step: confirm where the moment is ---------------------------------

const THUMBNAIL_HEIGHT = 54;

/** Roughly one thumbnail per second of clip, bounded for very short/long clips. */
function thumbnailCountFor(durationSeconds: number): number {
  return Math.max(10, Math.min(28, Math.round(durationSeconds)));
}

function WindowStep({
  store,
  capture,
  onConfirm
}: {
  store: RiderLensStore;
  capture: PendingCapture;
  onConfirm: () => void;
}) {
  const [thumbnails, setThumbnails] = useState<Array<{ t: number; uri: string; aspectRatio: number }>>([]);
  const windowSeconds = Math.max(0, capture.trimEndSeconds - capture.trimStartSeconds);

  useEffect(() => {
    let active = true;
    setThumbnails([]);
    const duration = capture.durationSeconds;
    const count = thumbnailCountFor(duration);
    const times = Array.from({ length: count }, (_, index) => (duration * (index + 0.5)) / count);
    void Promise.all(
      times.map(async (t) => {
        try {
          const result = await VideoThumbnails.getThumbnailAsync(capture.uri, { time: Math.round(t * 1000), quality: 0.3 });
          // Keep the source aspect ratio — a squished frame misleads the trim.
          const aspectRatio = result.width && result.height ? result.width / result.height : 16 / 9;
          return { t, uri: result.uri, aspectRatio };
        } catch {
          return undefined;
        }
      })
    ).then((generated) => {
      if (active) setThumbnails(generated.filter(Boolean) as Array<{ t: number; uri: string; aspectRatio: number }>);
    });
    return () => {
      active = false;
    };
    // Thumbnails depend only on the source clip, not on the trim values.
  }, [capture.uri, capture.durationSeconds]);

  const statusLine =
    capture.windowStatus === "checking"
      ? "Looking for the moment…"
      : capture.windowStatus === "ai"
        ? "AI found the moment — adjust if needed."
        : "Set the window around the moment.";

  return (
    <Card style={styles.windowCard}>
      <View style={styles.splitRow}>
        <Chip tone={capture.windowStatus === "ai" ? "cyan" : "neutral"} icon={capture.windowStatus === "ai" ? Sparkles : Scissors}>
          {capture.windowStatus === "ai" ? "AI window" : "Window"}
        </Chip>
        <View style={styles.splitRowRight}>
          <NumberText color={tokens.textMuted} size={12} weight="bold">
            {windowSeconds.toFixed(1)}s selected
          </NumberText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rotate clip 90 degrees"
            onPress={store.rotatePendingCapture}
            style={[styles.rotateButton, capture.rotateDegrees > 0 && styles.rotateButtonActive]}
          >
            <RotateCw color={capture.rotateDegrees > 0 ? tokens.graphite : tokens.text} size={16} strokeWidth={2.4} />
            {capture.rotateDegrees > 0 ? (
              <NumberText size={11} weight="bold" color={tokens.graphite}>
                {capture.rotateDegrees}°
              </NumberText>
            ) : null}
          </Pressable>
        </View>
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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbnailRow}>
          {thumbnails.map((thumbnail) => {
            const inWindow = thumbnail.t >= capture.trimStartSeconds && thumbnail.t <= capture.trimEndSeconds;
            // A quarter turn swaps the cell's aspect; the image keeps its own
            // aspect and is rotated into place, so nothing distorts.
            const quarterTurn = capture.rotateDegrees % 180 !== 0;
            const displayAspect = quarterTurn ? 1 / thumbnail.aspectRatio : thumbnail.aspectRatio;
            const cellWidth = THUMBNAIL_HEIGHT * displayAspect;
            return (
              <View
                key={thumbnail.t}
                style={[
                  styles.thumbnailCell,
                  !inWindow && styles.thumbnailOutside,
                  { width: cellWidth, height: THUMBNAIL_HEIGHT }
                ]}
              >
                <Image
                  source={{ uri: thumbnail.uri }}
                  style={{
                    width: quarterTurn ? THUMBNAIL_HEIGHT : cellWidth,
                    height: quarterTurn ? cellWidth : THUMBNAIL_HEIGHT,
                    transform: capture.rotateDegrees ? [{ rotate: `${capture.rotateDegrees}deg` }] : undefined
                  }}
                  resizeMethod="resize"
                />
              </View>
            );
          })}
        </ScrollView>
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
        <Button onPress={onConfirm} style={styles.actionButton}>
          {capture.reprocessRecordId ? "Rebuild record" : "Create record"}
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
  sheetHeaderText: {
    flex: 1,
    gap: 2
  },
  sheetClose: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: tokens.surfaceMuted
  },
  content: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  actionGrid: {
    flexDirection: "row",
    gap: spacing.md
  },
  actionButton: {
    flex: 1
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
    gap: 4
  },
  thumbnailCell: {
    borderRadius: 4,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.graphite
  },
  splitRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  rotateButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 34,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: tokens.surfaceMuted,
    justifyContent: "center"
  },
  rotateButtonActive: {
    backgroundColor: tokens.electric
  },
  thumbnailOutside: {
    opacity: 0.3
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
