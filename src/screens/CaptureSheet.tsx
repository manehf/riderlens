import Slider from "@react-native-community/slider";
import { useEventListener } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import * as VideoThumbnails from "expo-video-thumbnails";
import { AlertTriangle, Minus, Pause, Play, Plus, RotateCw, Scissors, X } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText, Button, Card, Chip, DisplayText, NumberText } from "../components/ui";
import type { PendingCapture, RiderLensStore } from "../hooks/useRiderLensMvp";
import {
  MAX_ANALYSIS_WINDOW_SECONDS,
  MIN_ANALYSIS_WINDOW_SECONDS,
  shouldLoopSelection
} from "../services/captureWindow";
import { radius, spacing, tokens } from "../theme/tokens";

type CaptureSheetProps = {
  store: RiderLensStore;
  visible: boolean;
  onClose: () => void;
};

/** Native camera/picker first, then this focused editor chooses one jump. */
export function CaptureSheet({ store, visible, onClose }: CaptureSheetProps) {
  const reprocessing = Boolean(store.pendingCapture?.reprocessRecordId);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  function close() {
    store.cancelPendingCapture();
    onClose();
  }

  async function confirmCapture() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const committed = await store.confirmPendingCapture();
      if (committed) onClose();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.sheetRoot}>
        <View style={styles.sheetHeader}>
          <View style={styles.sheetHeaderText}>
            <DisplayText size={24}>{reprocessing ? "REPROCESS JUMP" : "SELECT THE JUMP"}</DisplayText>
            <AppText color={tokens.textMuted} size={12}>
              {reprocessing
                ? "Adjust up to 8 seconds or correct the orientation, then rebuild the analysis."
                : "Select up to 8 seconds, from approach through landing."}
            </AppText>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close capture" onPress={close} style={styles.sheetClose}>
            <X color={tokens.text} size={20} strokeWidth={2.4} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {store.pendingCapture ? (
            <WindowStep
              store={store}
              capture={store.pendingCapture}
              onConfirm={confirmCapture}
              onCancel={close}
              submitting={submitting}
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
              RiderLens captures what happened — it does not make a jump safe. Practice within your ability and wear
              protective gear.
            </AppText>
          </Card>
        </ScrollView>
      </View>
    </Modal>
  );
}

const THUMBNAIL_HEIGHT = 54;
const PREVIEW_HEIGHT = 238;

function thumbnailCountFor(durationSeconds: number): number {
  return Math.max(10, Math.min(28, Math.round(durationSeconds)));
}

function WindowStep({
  store,
  capture,
  onConfirm,
  onCancel,
  submitting
}: {
  store: RiderLensStore;
  capture: PendingCapture;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [thumbnails, setThumbnails] = useState<Array<{ t: number; uri: string; aspectRatio: number }>>([]);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: PREVIEW_HEIGHT });
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(capture.trimStartSeconds);
  const playbackActiveRef = useRef(false);
  const windowSeconds = Math.max(0, capture.trimEndSeconds - capture.trimStartSeconds);
  const quarterTurn = capture.rotateDegrees % 180 !== 0;
  const reprocessing = Boolean(capture.reprocessRecordId);
  const { analysisAccess } = store;
  const needsPro = !reprocessing && !analysisAccess.isPro && analysisAccess.freeRemaining === 0;
  const accessReady = reprocessing || analysisAccess.ready;

  const player = useVideoPlayer(capture.uri, (instance) => {
    instance.loop = false;
    instance.muted = true;
    instance.timeUpdateEventInterval = 0.1;
    instance.currentTime = capture.trimStartSeconds;
  });

  useEventListener(player, "sourceLoad", ({ duration }) => {
    store.updatePendingDuration(duration);
  });

  useEventListener(player, "playingChange", ({ isPlaying }) => {
    playbackActiveRef.current = isPlaying;
    setPlaying(isPlaying);
  });

  useEventListener(player, "timeUpdate", ({ currentTime: nextTime }) => {
    if (shouldLoopSelection(playbackActiveRef.current, nextTime, capture.trimEndSeconds)) {
      player.currentTime = capture.trimStartSeconds;
      setCurrentTime(capture.trimStartSeconds);
      return;
    }
    setCurrentTime(nextTime);
  });

  useEffect(() => {
    playbackActiveRef.current = false;
    player.currentTime = capture.trimStartSeconds;
    setCurrentTime(capture.trimStartSeconds);
  }, [capture.uri, player]);

  useEffect(() => {
    let active = true;
    setThumbnails([]);
    const duration = capture.durationSeconds;
    const count = thumbnailCountFor(duration);
    const times = Array.from({ length: count }, (_, index) => (duration * (index + 0.5)) / count);
    void Promise.all(
      times.map(async (t) => {
        try {
          const result = await VideoThumbnails.getThumbnailAsync(capture.uri, {
            time: Math.round(t * 1000),
            quality: 0.3
          });
          const aspectRatio = result.width && result.height ? result.width / result.height : 16 / 9;
          return { t, uri: result.uri, aspectRatio };
        } catch {
          return undefined;
        }
      })
    ).then((generated) => {
      if (!active) return;
      const frames = generated.filter(Boolean) as Array<{ t: number; uri: string; aspectRatio: number }>;
      setThumbnails(frames);
    });
    return () => {
      active = false;
    };
  }, [capture.uri, capture.durationSeconds]);

  const seekAndPause = useCallback(
    (time: number) => {
      const bounded = Math.max(0, Math.min(time, capture.durationSeconds));
      playbackActiveRef.current = false;
      player.pause();
      setPlaying(false);
      player.currentTime = bounded;
      setCurrentTime(bounded);
    },
    [capture.durationSeconds, player]
  );

  const togglePlayback = useCallback(() => {
    if (playing) {
      playbackActiveRef.current = false;
      player.pause();
      return;
    }
    if (player.currentTime < capture.trimStartSeconds || player.currentTime >= capture.trimEndSeconds - 0.03) {
      player.currentTime = capture.trimStartSeconds;
      setCurrentTime(capture.trimStartSeconds);
    }
    playbackActiveRef.current = true;
    player.play();
  }, [capture.trimEndSeconds, capture.trimStartSeconds, player, playing]);

  const previewVideoStyle = useMemo(() => {
    if (previewSize.width <= 0) return StyleSheet.absoluteFill;
    const width = quarterTurn ? previewSize.height : previewSize.width;
    const height = quarterTurn ? previewSize.width : previewSize.height;
    return {
      position: "absolute" as const,
      width,
      height,
      left: (previewSize.width - width) / 2,
      top: (previewSize.height - height) / 2,
      transform: capture.rotateDegrees ? [{ rotate: `${capture.rotateDegrees}deg` }] : undefined
    };
  }, [capture.rotateDegrees, previewSize, quarterTurn]);

  return (
    <Card style={styles.windowCard}>
      <View style={styles.splitRow}>
        <Chip tone="electric" icon={Scissors}>
          Jump section
        </Chip>
        <View style={styles.splitRowRight}>
          <NumberText color={tokens.textMuted} size={12} weight="bold">
            {windowSeconds.toFixed(1)}s / {MAX_ANALYSIS_WINDOW_SECONDS}s
          </NumberText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rotate video 90 degrees clockwise"
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

      <View
        style={styles.previewFrame}
        onLayout={(event) =>
          setPreviewSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })
        }
      >
        <VideoView
          player={player}
          style={previewVideoStyle}
          contentFit="contain"
          nativeControls={false}
          fullscreenOptions={{ enable: false }}
          surfaceType="textureView"
        />
        <View style={styles.previewControls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playing ? "Pause selected moment" : "Play selected moment"}
            onPress={togglePlayback}
            style={styles.playButton}
          >
            {playing ? (
              <Pause color={tokens.graphite} size={17} fill={tokens.graphite} />
            ) : (
              <Play color={tokens.graphite} size={17} fill={tokens.graphite} />
            )}
          </Pressable>
          <NumberText size={12} weight="bold" color={tokens.surface}>
            {currentTime.toFixed(1)}s
          </NumberText>
        </View>
      </View>

      {thumbnails.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbnailRow}>
          {thumbnails.map((thumbnail) => {
            const inWindow = thumbnail.t >= capture.trimStartSeconds && thumbnail.t <= capture.trimEndSeconds;
            const displayAspect = quarterTurn ? 1 / thumbnail.aspectRatio : thumbnail.aspectRatio;
            const cellWidth = THUMBNAIL_HEIGHT * displayAspect;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Preview at ${thumbnail.t.toFixed(1)} seconds`}
                key={thumbnail.t}
                onPress={() => seekAndPause(thumbnail.t)}
                style={[
                  styles.thumbnailCell,
                  !inWindow && styles.thumbnailOutside,
                  inWindow && styles.thumbnailSelected,
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
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <WindowControl
        label="Start"
        value={capture.trimStartSeconds}
        minimumValue={0}
        maximumValue={capture.durationSeconds}
        minimumAllowedValue={Math.max(0, capture.trimEndSeconds - MAX_ANALYSIS_WINDOW_SECONDS)}
        maximumAllowedValue={Math.max(0, capture.trimEndSeconds - MIN_ANALYSIS_WINDOW_SECONDS)}
        onChange={(value) => store.updatePendingWindow({ trimStartSeconds: value })}
        onPreview={seekAndPause}
      />
      <WindowControl
        label="End"
        value={capture.trimEndSeconds}
        minimumValue={0}
        maximumValue={capture.durationSeconds}
        minimumAllowedValue={Math.min(
          capture.durationSeconds,
          capture.trimStartSeconds + MIN_ANALYSIS_WINDOW_SECONDS
        )}
        maximumAllowedValue={Math.min(
          capture.durationSeconds,
          capture.trimStartSeconds + MAX_ANALYSIS_WINDOW_SECONDS
        )}
        onChange={(value) => store.updatePendingWindow({ trimEndSeconds: value })}
        onPreview={seekAndPause}
      />

      {!reprocessing ? (
        <View style={styles.allowanceRow}>
          {analysisAccess.isPro ? (
            <Chip tone="green">RiderLens Pro</Chip>
          ) : (
            <>
              <NumberText weight="bold" size={13} color={needsPro ? tokens.amber : tokens.green}>
                {analysisAccess.freeRemaining}
              </NumberText>
              <AppText size={12} weight="semi" color={tokens.textMuted}>
                {analysisAccess.freeRemaining === 1 ? "free analysis left this month" : "free analyses left this month"}
              </AppText>
            </>
          )}
        </View>
      ) : null}

      <View style={styles.actionGrid}>
        <Button
          disabled={submitting || !accessReady}
          onPress={() => void onConfirm()}
          style={styles.actionButton}
        >
          {submitting
            ? needsPro
              ? "Opening Pro"
              : "Saving"
            : reprocessing
              ? "Rebuild"
              : needsPro
                ? "Upgrade"
                : "Analyze"}
        </Button>
        <Button variant="secondary" onPress={onCancel} style={styles.actionButton}>
          Cancel
        </Button>
      </View>
    </Card>
  );
}

function WindowControl({
  label,
  value,
  minimumValue,
  maximumValue,
  minimumAllowedValue,
  maximumAllowedValue,
  onChange,
  onPreview
}: {
  label: string;
  value: number;
  minimumValue: number;
  maximumValue: number;
  minimumAllowedValue: number;
  maximumAllowedValue: number;
  onChange: (value: number) => void;
  onPreview: (value: number) => void;
}) {
  const commit = (nextValue: number) => {
    const bounded = Math.max(minimumAllowedValue, Math.min(nextValue, maximumAllowedValue));
    onChange(bounded);
    onPreview(bounded);
  };
  const canMoveEarlier = value > minimumAllowedValue + 0.001;
  const canMoveLater = value < maximumAllowedValue - 0.001;

  return (
    <View style={styles.windowControl}>
      <View style={styles.windowControlHeader}>
        <AppText weight="semi" size={12} color={tokens.textMuted}>
          {label.toUpperCase()}
        </AppText>
        <NumberText weight="bold">{value.toFixed(1)}s</NumberText>
      </View>
      <View style={styles.sliderRow}>
        <WindowStepButton
          direction="earlier"
          label={label}
          disabled={!canMoveEarlier}
          onPress={() => commit(value - 0.1)}
        />
        <Slider
          style={styles.rangeSlider}
          minimumValue={minimumValue}
          maximumValue={Math.max(minimumValue, maximumValue)}
          step={0.1}
          value={value}
          minimumTrackTintColor={tokens.electric}
          maximumTrackTintColor={tokens.border}
          thumbTintColor={tokens.electric}
          onValueChange={commit}
        />
        <WindowStepButton
          direction="later"
          label={label}
          disabled={!canMoveLater}
          onPress={() => commit(value + 0.1)}
        />
      </View>
    </View>
  );
}

const HOLD_DELAY_MS = 320;
const HOLD_REPEAT_MS = 70;

function WindowStepButton({
  direction,
  label,
  disabled,
  onPress
}: {
  direction: "earlier" | "later";
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const Icon = direction === "earlier" ? Minus : Plus;
  // Hold to scrub continuously; a plain tap still moves one step. Refs keep
  // the repeating timer reading the latest value across re-renders.
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heldRef = useRef(false);

  const stopHolding = useCallback(() => {
    if (delayRef.current) {
      clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    if (repeatRef.current) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  }, []);
  useEffect(() => stopHolding, [stopHolding]);
  useEffect(() => {
    if (disabled) stopHolding();
  }, [disabled, stopHolding]);

  const handlePressIn = useCallback(() => {
    heldRef.current = false;
    stopHolding();
    delayRef.current = setTimeout(() => {
      delayRef.current = null;
      heldRef.current = true;
      onPressRef.current();
      repeatRef.current = setInterval(() => onPressRef.current(), HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
  }, [stopHolding]);

  const handlePress = useCallback(() => {
    if (heldRef.current) return;
    stopHolding();
    onPressRef.current();
  }, [stopHolding]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Move ${label.toLowerCase()} ${direction}`}
      accessibilityHint="Adjusts by a tenth of a second; hold to move continuously"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={stopHolding}
      cancelable={false}
      hitSlop={4}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.windowStepButton,
        pressed && !disabled && styles.windowStepButtonPressed,
        disabled && styles.windowStepButtonDisabled
      ]}
    >
      {({ pressed }) => (
        <Icon
          color={disabled ? tokens.textMuted : pressed ? tokens.graphite : tokens.electric}
          size={18}
          strokeWidth={2.6}
        />
      )}
    </Pressable>
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
  windowCard: {
    gap: spacing.md
  },
  splitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
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
  previewFrame: {
    height: PREVIEW_HEIGHT,
    overflow: "hidden",
    backgroundColor: tokens.graphite,
    borderRadius: radius.md
  },
  previewControls: {
    position: "absolute",
    left: spacing.sm,
    right: spacing.sm,
    bottom: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  playButton: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.electric
  },
  thumbnailRow: {
    gap: 4
  },
  thumbnailCell: {
    borderRadius: 4,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.graphite,
    borderWidth: 2,
    borderColor: "transparent"
  },
  thumbnailSelected: {
    borderColor: tokens.electric
  },
  thumbnailOutside: {
    opacity: 0.3
  },
  windowControl: {
    gap: spacing.xs
  },
  windowControlHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sliderRow: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  rangeSlider: {
    flex: 1,
    height: 40
  },
  windowStepButton: {
    width: 44,
    height: 44,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: tokens.graphite,
    backgroundColor: tokens.graphite
  },
  windowStepButtonPressed: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electric,
    transform: [{ scale: 0.94 }]
  },
  windowStepButtonDisabled: {
    borderColor: tokens.border,
    backgroundColor: tokens.surfaceMuted,
    opacity: 0.55
  },
  actionGrid: {
    flexDirection: "row",
    gap: spacing.md
  },
  allowanceRow: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs
  },
  actionButton: {
    flex: 1
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
