import Slider from "@react-native-community/slider";
import { useEvent, useEventListener } from "expo";
import * as ScreenOrientation from "expo-screen-orientation";
import { useVideoPlayer, VideoView } from "expo-video";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Film,
  Maximize2,
  Pause,
  PersonStanding,
  Play,
  Plus,
  RefreshCcw,
  Share2,
  Sparkles,
  Trash2,
  X
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getRecordTitle, getSystemTags } from "../services/analysis";
import { loadRecordDetail } from "../services/recordStore";
import { radius, spacing, tokens } from "../theme/tokens";
import type { FilmstripFrame, JumpRecord, JumpRecordDetail } from "../types/domain";
import { AppText, Button, Card, Chip, NumberText } from "./ui";

type RecordCardProps = {
  record: JumpRecord;
  onShare?: (record: JumpRecord, preferSkeleton?: boolean) => void;
  onShareLink?: (record: JumpRecord) => void;
  onRetry?: (record: JumpRecord) => void;
  /** Reopen the trim step to fix rotation or the window and rebuild the record. */
  onReprocess?: (record: JumpRecord) => void;
  /** Off when a surrounding header (the detail sheet) already names the record. */
  showTitle?: boolean;
  onDelete?: (record: JumpRecord) => void;
  onAddTag?: (recordId: string, tag: string) => void;
  onRemoveTag?: (recordId: string, tag: string) => void;
  /** Previously-used tags offered as one-tap suggestions in the editor. */
  tagSuggestions?: string[];
};

/** Fallback when a record has a clip but no filmstrip to drive the viewer. */
function ClipPlayer({ clipUri }: { clipUri: string }) {
  const player = useVideoPlayer(clipUri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });
  return <VideoView player={player} style={styles.fallbackPlayer} contentFit="contain" nativeControls />;
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

// Real speed by default — least surprise; analysis speeds are one tap away.
// The speed button cycles through these for both lenses.
const PLAYBACK_SPEEDS = [1, 0.5, 0.25];
const DEFAULT_SPEED = 1;

// Filmstrip-as-scrubber geometry: must match the filmstrip styles below.
const FILMSTRIP_CELL_WIDTH = 114;
const FILMSTRIP_GAP = 8;
const FILMSTRIP_STEP = FILMSTRIP_CELL_WIDTH + FILMSTRIP_GAP;
// The scrubber renders at most this many cells. Records now carry every
// analyzed frame (up to 450); mounting them all as Images would blow the
// decoded-bitmap budget on iOS. The strip shows every Nth frame for
// navigation — stepping (and the fullscreen slider) still hits every frame.
const FILMSTRIP_MAX_CELLS = 120;

function speedLabel(speed: number): string {
  return speed === 1 ? "1×" : speed === 0.5 ? "½×" : "¼×";
}

type ViewerMode = "skeleton" | "video";

// Frames kept decoded on each side of the current one. Stepping inside the
// window is a pure opacity flip — instant, and every frame is guaranteed to
// display. Edge frames decode 4 steps before they're needed, which also keeps
// playback ahead of the JPEG decoder. Memory: ~2*WINDOW+1 decoded frames.
const FRAME_WINDOW = 4;
const FRAME_HOLD_DELAY_MS = 400;
const FRAME_HOLD_REPEAT_MS = 110;

/** Sliding-window frame display: all frames within FRAME_WINDOW of the current
 * index stay mounted (decoded, hidden); only the current one is visible.
 * Keys are stable per frame, so sliding the window never remounts frames that
 * remain inside it. Wraps around the clip end so looped playback stays smooth. */
function FrameWindow({ frames, index }: { frames: FilmstripFrame[]; index: number }) {
  const mounted = useMemo(() => {
    const indices = new Set<number>();
    for (let delta = -FRAME_WINDOW; delta <= FRAME_WINDOW; delta++) {
      indices.add((index + delta + frames.length) % frames.length);
    }
    return [...indices].sort((a, b) => a - b);
  }, [frames.length, index]);

  return (
    <View style={styles.frameStack}>
      {mounted.map((frameIndex) => (
        <Image
          key={frames[frameIndex].t}
          source={{ uri: frames[frameIndex].image }}
          style={[StyleSheet.absoluteFill, frameIndex !== index && styles.frameHidden]}
          resizeMode="contain"
          fadeDuration={0}
        />
      ))}
    </View>
  );
}

type JumpViewerProps = {
  /** Owned by RecordCard: the toggle lives in the card header. */
  mode: ViewerMode;
  clipUri?: string;
  /** Skeleton-burned video used for smooth native playback. The JPEG filmstrip
   * remains the paused, frame-accurate inspection surface. */
  skeletonClipUri?: string;
  /** Source-video time of the clip's first frame: filmstrip `t` values are in
   * source time, the clip starts at the confirmed window start. */
  clipStartSeconds: number;
  frames: FilmstripFrame[];
  labels: Map<number, string>;
  onZoom: (frame: FilmstripFrame) => void;
  /** Fullscreen variant fills its container instead of a 16:9 card viewport. */
  variant?: "card" | "fullscreen";
  initialFrameIndex?: number;
  onFrameChange?: (index: number) => void;
  /** Renders the expand control on the viewport when provided. */
  onExpand?: () => void;
};

/** One viewport, two lenses on the same moment. `frameIndex` is the single source
 * of truth for position: the skeleton mode steps it on a timer, the video mode
 * syncs it from playback time, and the slider + filmstrip scrub it in both. */
function JumpViewer({
  mode,
  clipUri,
  skeletonClipUri,
  clipStartSeconds,
  frames,
  labels,
  onZoom,
  variant = "card",
  initialFrameIndex = 0,
  onFrameChange,
  onExpand
}: JumpViewerProps) {
  const maxFrameIndex = Math.max(0, frames.length - 1);
  const initialIndex = Math.max(0, Math.min(initialFrameIndex, maxFrameIndex));
  const [frameIndex, setFrameIndex] = useState(initialIndex);
  const [skeletonPlaying, setSkeletonPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const frameIndexRef = useRef(initialIndex);
  const suppressVideoSyncUntilRef = useRef(0);
  const stripRef = useRef<ScrollView>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const stripInteractingRef = useRef(false);
  const stripSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackUri = mode === "skeleton" ? skeletonClipUri : clipUri;
  const usesNativePlayback = Boolean(playbackUri);
  // In landscape fullscreen every vertical point goes to the footage.
  const compactControls = variant === "fullscreen" && windowWidth > windowHeight;

  const player = useVideoPlayer(playbackUri ?? null, (instance) => {
    // The skeleton share clip contains an end card after the analyzed frames,
    // so its loop is bounded manually by the filmstrip duration below.
    instance.loop = mode === "video";
    instance.muted = true;
    instance.playbackRate = DEFAULT_SPEED;
    instance.timeUpdateEventInterval = 0.05;
  });
  const { isPlaying: videoPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });
  const playing = usesNativePlayback ? videoPlaying : skeletonPlaying;

  // One speed for both lenses.
  useEffect(() => {
    if (playbackUri) player.playbackRate = speed;
  }, [playbackUri, player, speed]);

  const cycleSpeed = useCallback(() => {
    setSpeed((current) => {
      const index = PLAYBACK_SPEEDS.indexOf(current);
      return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length];
    });
  }, []);

  const frameIntervalMs = useMemo(() => {
    if (frames.length < 2) return 120;
    const realInterval = ((frames[frames.length - 1].t - frames[0].t) / (frames.length - 1)) * 1000;
    return Math.max(40, realInterval / speed);
  }, [frames, speed]);

  const clipTimeOf = useCallback(
    (frame: FilmstripFrame) => Math.max(0, frame.t - clipStartSeconds),
    [clipStartSeconds]
  );

  const analyzedClipDuration = useMemo(() => {
    if (frames.length === 0) return 0;
    const frameStep =
      frames.length > 1 ? Math.max(1 / 60, (frames[frames.length - 1].t - frames[0].t) / (frames.length - 1)) : 1 / 30;
    return Math.max(frameStep, clipTimeOf(frames[frames.length - 1]) + frameStep);
  }, [clipTimeOf, frames]);

  const commitFrameIndex = useCallback(
    (index: number) => {
      const nextIndex = Math.max(0, Math.min(index, Math.max(0, frames.length - 1)));
      frameIndexRef.current = nextIndex;
      setFrameIndex(nextIndex);
      return nextIndex;
    },
    [frames.length]
  );

  // Legacy fallback for records whose skeleton video failed to render. Normal
  // Skeleton playback uses the native player and never enters this timer.
  useEffect(() => {
    if (mode !== "skeleton" || usesNativePlayback || !skeletonPlaying || frames.length < 2) return;
    const timer = setInterval(() => {
      commitFrameIndex((frameIndexRef.current + 1) % frames.length);
    }, frameIntervalMs);
    return () => clearInterval(timer);
  }, [commitFrameIndex, mode, usesNativePlayback, skeletonPlaying, frames.length, frameIntervalMs]);

  // While either native clip plays, keep frameIndex (slider + strip highlight)
  // in sync. The skeleton clip has a share end card, so loop at the final
  // analyzed frame before that card can enter the viewer.
  // Manual frame steps are authoritative while paused; native video can emit a
  // nearby decoded timestamp immediately after seeking.
  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    if (!usesNativePlayback || !videoPlaying || frames.length === 0 || Date.now() < suppressVideoSyncUntilRef.current) {
      return;
    }
    if (mode === "skeleton" && analyzedClipDuration > 0 && currentTime >= analyzedClipDuration) {
      // Wrap before the end card. The seek must not run while playing:
      // resuming into AVFoundation's in-flight seek livelocks the clock
      // (time reports bounce around the boundary and the viewer flickers).
      // Pause -> seek -> play serializes it; the suppression window keeps
      // post-seek echo timestamps from re-entering this handler.
      suppressVideoSyncUntilRef.current = Date.now() + 350;
      player.pause();
      player.currentTime = 0;
      player.play();
      commitFrameIndex(0);
      return;
    }
    const sourceTime = currentTime + clipStartSeconds;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    frames.forEach((frame, index) => {
      const distance = Math.abs(frame.t - sourceTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    commitFrameIndex(best);
  });

  const seekToFrame = useCallback(
    (index: number) => {
      suppressVideoSyncUntilRef.current = Date.now() + 350;
      if (usesNativePlayback) player.pause();
      setSkeletonPlaying(false);
      const nextIndex = commitFrameIndex(index);
      const frame = frames[nextIndex];
      if (frame && playbackUri) {
        player.currentTime = clipTimeOf(frame);
      }
    },
    [clipTimeOf, commitFrameIndex, frames, playbackUri, player, usesNativePlayback]
  );

  const stepFrame = useCallback(
    (delta: number) => {
      seekToFrame(frameIndexRef.current + delta);
    },
    [seekToFrame]
  );

  const cancelStripInteraction = useCallback(() => {
    if (stripSettleTimerRef.current) {
      clearTimeout(stripSettleTimerRef.current);
      stripSettleTimerRef.current = null;
    }
    stripInteractingRef.current = false;
  }, []);

  useEffect(() => cancelStripInteraction, [cancelStripInteraction]);

  const togglePlayback = useCallback(() => {
    cancelStripInteraction();
    if (usesNativePlayback) {
      if (videoPlaying) {
        player.pause();
      } else {
        // Resuming at (or past) the analyzed end would race the wrap seek -
        // restart cleanly from the top instead. Keep a short suppression
        // window so echo timestamps from a just-issued seek don't fight the
        // fresh playback position.
        if (mode === "skeleton" && analyzedClipDuration > 0 && player.currentTime >= analyzedClipDuration - 0.05) {
          player.currentTime = 0;
          commitFrameIndex(0);
        }
        suppressVideoSyncUntilRef.current = Date.now() + 350;
        player.play();
      }
      return;
    }
    setSkeletonPlaying((value) => !value);
  }, [analyzedClipDuration, cancelStripInteraction, commitFrameIndex, mode, player, usesNativePlayback, videoPlaying]);

  // --- Filmstrip as scrubber: drag the strip under the fixed playhead. ------
  // Edge padding lets the first and last frames reach the center playhead.
  const stripEdgePadding = Math.max(0, (stripWidth - FILMSTRIP_CELL_WIDTH) / 2);

  // One strip cell represents `stripStride` frames; scroll position maps
  // fractionally so single-frame stepping still moves the strip smoothly.
  const stripStride = Math.max(1, Math.ceil(frames.length / FILMSTRIP_MAX_CELLS));
  const stripCells = useMemo(
    () => frames.map((frame, index) => ({ frame, index })).filter((cell) => cell.index % stripStride === 0),
    [frames, stripStride]
  );
  // Event labels land on the nearest rendered cell so tags survive thinning.
  const cellLabels = useMemo(() => {
    if (stripStride === 1) return labels;
    const mapped = new Map<number, string>();
    for (const [index, name] of labels.entries()) {
      mapped.set(Math.round(index / stripStride) * stripStride, name);
    }
    return mapped;
  }, [labels, stripStride]);

  const scrubToOffset = useCallback(
    (offsetX: number) => {
      // Playback scrolls the strip to follow the current frame. Those native
      // onScroll events must never seek the player back to a stale offset.
      // Check the event-driven state too: the native flag reads false while a
      // seek is in flight even though playback is logically running.
      if (player.playing || videoPlaying || skeletonPlaying) return;
      const cell = Math.round(offsetX / FILMSTRIP_STEP);
      const index = Math.max(0, Math.min(cell * stripStride, frames.length - 1));
      if (index === frameIndexRef.current) return;
      suppressVideoSyncUntilRef.current = Date.now() + 350;
      commitFrameIndex(index);
      const frame = frames[index];
      if (frame && playbackUri) {
        player.currentTime = clipTimeOf(frame);
      }
    },
    [clipTimeOf, commitFrameIndex, frames, playbackUri, player, skeletonPlaying, stripStride, videoPlaying]
  );

  const handleStripDragStart = useCallback(() => {
    if (stripSettleTimerRef.current) {
      clearTimeout(stripSettleTimerRef.current);
      stripSettleTimerRef.current = null;
    }
    stripInteractingRef.current = true;
    if (usesNativePlayback) player.pause();
    setSkeletonPlaying(false);
  }, [player, usesNativePlayback]);

  const handleStripScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!stripInteractingRef.current) return;
      scrubToOffset(event.nativeEvent.contentOffset.x);
    },
    [scrubToOffset]
  );

  const handleStripDragEnd = useCallback(() => {
    // Momentum may follow the drag; only release the strip if it doesn't.
    stripSettleTimerRef.current = setTimeout(() => {
      stripInteractingRef.current = false;
    }, 140);
  }, []);

  const handleStripMomentumStart = useCallback(() => {
    if (!stripInteractingRef.current) return;
    if (stripSettleTimerRef.current) {
      clearTimeout(stripSettleTimerRef.current);
    }
    // Failsafe instead of a plain cancel: iOS never fires momentumScrollEnd
    // when a programmatic scrollTo interrupts the momentum, and a stuck
    // interacting flag turns the playback-follow scrolls into seeks.
    stripSettleTimerRef.current = setTimeout(() => {
      stripSettleTimerRef.current = null;
      stripInteractingRef.current = false;
    }, 1000);
  }, []);

  const handleStripMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Programmatic scrollTo calls used during playback can emit momentum
      // events on iOS. Never feed those stale offsets back into frameIndex.
      if (!stripInteractingRef.current) return;
      if (stripSettleTimerRef.current) {
        clearTimeout(stripSettleTimerRef.current);
        stripSettleTimerRef.current = null;
      }
      scrubToOffset(event.nativeEvent.contentOffset.x);
      stripInteractingRef.current = false;
    },
    [scrubToOffset]
  );

  // Playback/stepping moves the strip; user drags move the frame (guarded above).
  useEffect(() => {
    if (stripInteractingRef.current) return;
    stripRef.current?.scrollTo({ x: (frameIndex / stripStride) * FILMSTRIP_STEP, animated: false });
  }, [frameIndex, stripStride, stripWidth]);

  // Carry the current moment across mode switches so the toggle never jumps in time.
  const previousModeRef = useRef(mode);
  useEffect(() => {
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    if (usesNativePlayback) player.pause();
    setSkeletonPlaying(false);
    if (playbackUri) {
      const frame = frames[frameIndexRef.current];
      if (frame) player.currentTime = clipTimeOf(frame);
    }
  }, [clipTimeOf, frames, mode, playbackUri, player, usesNativePlayback]);

  // Start the video at the initial frame (matters when opening fullscreen mid-scrub).
  useEffect(() => {
    const frame = frames[frameIndexRef.current];
    if (playbackUri && frame) player.currentTime = clipTimeOf(frame);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onFrameChange?.(frameIndex);
  }, [frameIndex, onFrameChange]);

  const boundedFrameIndex = Math.min(frameIndex, frames.length - 1);
  const currentFrame = frames[boundedFrameIndex];

  // Phase banner, not a blip: the latest event at or before the current frame
  // stays visible until the next event replaces it, so it's readable mid-playback.
  const label = useMemo(() => {
    let current: string | undefined;
    for (const [index, name] of [...labels.entries()].sort((a, b) => a[0] - b[0])) {
      if (index > frameIndex) break;
      current = name;
    }
    return current;
  }, [frameIndex, labels]);

  return (
    <View style={variant === "fullscreen" ? styles.viewerFullscreen : styles.viewer}>
      <View style={variant === "fullscreen" ? styles.viewportFullscreen : styles.viewport}>
        {playbackUri ? (
          <>
            <VideoView
              player={player}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              nativeControls={false}
              surfaceType="textureView"
            />
            {mode === "skeleton" && !videoPlaying ? (
              <Pressable style={StyleSheet.absoluteFill} onPress={() => onZoom(currentFrame)}>
                <FrameWindow frames={frames} index={boundedFrameIndex} />
              </Pressable>
            ) : null}
          </>
        ) : (
          <Pressable style={StyleSheet.absoluteFill} onPress={() => onZoom(currentFrame)}>
            <FrameWindow frames={frames} index={boundedFrameIndex} />
          </Pressable>
        )}
        {label ? (
          <View style={styles.eventTagLarge}>
            <AppText size={11} weight="bold" color={tokens.graphite}>
              {label}
            </AppText>
          </View>
        ) : null}
        {onExpand ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fullscreen"
            onPress={onExpand}
            style={styles.expandButton}
          >
            <Maximize2 color={tokens.surface} size={16} strokeWidth={2.4} />
          </Pressable>
        ) : null}
      </View>

      {compactControls ? (
        // Landscape fullscreen: no room for the strip — a slim slider scrubs instead.
        <Slider
          style={styles.scrubber}
          minimumValue={0}
          maximumValue={Math.max(0, frames.length - 1)}
          step={1}
          value={frameIndex}
          minimumTrackTintColor={tokens.electric}
          maximumTrackTintColor={tokens.border}
          thumbTintColor={tokens.electric}
          onValueChange={(value) => seekToFrame(Math.round(value))}
        />
      ) : (
        /* The filmstrip IS the scrubber: drag it under the fixed playhead. */
        <View style={styles.filmstripWrap} onLayout={(event) => setStripWidth(event.nativeEvent.layout.width)}>
          <ScrollView
            ref={stripRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={FILMSTRIP_STEP}
            decelerationRate="fast"
            scrollEventThrottle={16}
            onScrollBeginDrag={handleStripDragStart}
            onScroll={handleStripScroll}
            onScrollEndDrag={handleStripDragEnd}
            onMomentumScrollBegin={handleStripMomentumStart}
            onMomentumScrollEnd={handleStripMomentumEnd}
            contentContainerStyle={[styles.filmstrip, { paddingHorizontal: stripEdgePadding }]}
          >
            {stripCells.map(({ frame, index }) => (
              <Pressable key={frame.t} onPress={() => seekToFrame(index)} style={styles.filmstripCell}>
                <Image
                  source={{ uri: frame.image }}
                  resizeMethod="resize"
                  style={[
                    styles.filmstripImage,
                    Math.abs(index - frameIndex) < stripStride && styles.filmstripImageActive
                  ]}
                />
                {cellLabels.has(index) ? (
                  <View style={styles.eventTag}>
                    <AppText size={10} weight="bold" color={tokens.graphite}>
                      {cellLabels.get(index)}
                    </AppText>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
          <View pointerEvents="none" style={styles.playhead} />
        </View>
      )}

      <View style={styles.playerControls}>
        <View style={styles.transportGroup}>
          <IconButton
            icon={ChevronLeft}
            label="Previous frame"
            onPress={() => stepFrame(-1)}
            repeatOnLongPress
          />
          <IconButton
            icon={playing ? Pause : Play}
            label={playing ? "Pause" : "Play"}
            emphasis
            onPress={togglePlayback}
          />
          <IconButton
            icon={ChevronRight}
            label="Next frame"
            onPress={() => stepFrame(1)}
            repeatOnLongPress
          />
        </View>
        <View style={styles.transportGroup}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Playback speed ${speedLabel(speed)}`}
            onPress={cycleSpeed}
            style={styles.speedButton}
          >
            <AppText size={10} weight="bold" color={tokens.textMuted} style={styles.speedCaption}>
              SPEED
            </AppText>
            <NumberText size={12} weight="bold">
              {speedLabel(speed)}
            </NumberText>
          </Pressable>
          <NumberText size={11} color={tokens.textMuted} style={styles.playerTime}>
            {currentFrame.t.toFixed(2)}s
          </NumberText>
        </View>
      </View>
    </View>
  );
}

type IconButtonProps = {
  icon: typeof Film;
  label: string;
  onPress: () => void;
  emphasis?: boolean;
  repeatOnLongPress?: boolean;
};

function IconButton({ icon: Icon, label, onPress, emphasis = false, repeatOnLongPress = false }: IconButtonProps) {
  const onPressRef = useRef(onPress);
  const holdDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handledLongPressRef = useRef(false);
  onPressRef.current = onPress;

  const stopHolding = useCallback(() => {
    if (holdDelayTimerRef.current) {
      clearTimeout(holdDelayTimerRef.current);
      holdDelayTimerRef.current = null;
    }
    if (repeatTimerRef.current) {
      clearInterval(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopHolding, [stopHolding]);

  const handlePressIn = useCallback(() => {
    handledLongPressRef.current = false;
    stopHolding();
    holdDelayTimerRef.current = setTimeout(() => {
      holdDelayTimerRef.current = null;
      handledLongPressRef.current = true;
      onPressRef.current();
      repeatTimerRef.current = setInterval(() => onPressRef.current(), FRAME_HOLD_REPEAT_MS);
    }, FRAME_HOLD_DELAY_MS);
  }, [stopHolding]);

  const handlePress = useCallback(() => {
    if (repeatOnLongPress && handledLongPressRef.current) return;
    stopHolding();
    onPressRef.current();
  }, [repeatOnLongPress, stopHolding]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={repeatOnLongPress ? "Hold to move through frames continuously" : undefined}
      cancelable={repeatOnLongPress ? false : undefined}
      onPressIn={repeatOnLongPress ? handlePressIn : undefined}
      onPressOut={repeatOnLongPress ? stopHolding : undefined}
      onPress={handlePress}
      style={({ pressed }) => [styles.iconButton, emphasis && styles.iconButtonEmphasis, pressed && styles.iconButtonPressed]}
    >
      <Icon color={emphasis ? tokens.graphite : tokens.text} size={18} strokeWidth={2.4} />
    </Pressable>
  );
}

type SegmentButtonProps = {
  icon: typeof Film;
  label: string;
  active: boolean;
  onPress: () => void;
};

function SegmentButton({ icon: Icon, label, active, onPress }: SegmentButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.segment, active && styles.segmentActive]}
    >
      <Icon color={active ? tokens.electric : tokens.textMuted} size={14} strokeWidth={2.4} />
      <AppText size={12} weight="bold" color={active ? tokens.electric : tokens.textMuted}>
        {label}
      </AppText>
    </Pressable>
  );
}

type TagSectionProps = {
  record: JumpRecord;
  suggestions: string[];
  onAdd: (recordId: string, tag: string) => void;
  onRemove: (recordId: string, tag: string) => void;
};

/** System tags come from the AI review and are not removable; rider tags are
 * one tap to remove, and adding is mostly one tap too (suggestions first). */
function TagSection({ record, suggestions, onAdd, onRemove }: TagSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const systemTags = getSystemTags(record);
  const userTags = record.tags ?? [];
  const applied = new Set([...systemTags, ...userTags].map((tag) => tag.toLowerCase()));
  const available = suggestions.filter((tag) => !applied.has(tag.toLowerCase()));

  const submitDraft = () => {
    const cleaned = draft.trim();
    if (cleaned) onAdd(record.id, cleaned);
    setDraft("");
  };

  return (
    <View style={styles.tagSection}>
      <View style={styles.tagRow}>
        {systemTags.map((tag) => (
          <Chip key={`system-${tag}`} tone={tag === "crash" ? "red" : "cyan"} icon={Sparkles}>
            {tag}
          </Chip>
        ))}
        {userTags.map((tag) => (
          <Pressable
            key={tag}
            accessibilityRole="button"
            accessibilityLabel={`Remove tag ${tag}`}
            onPress={() => onRemove(record.id, tag)}
            style={styles.userTag}
          >
            <AppText size={12} weight="bold">
              {tag}
            </AppText>
            <X color={tokens.textMuted} size={12} strokeWidth={2.6} />
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? "Close tag editor" : "Add a tag"}
          onPress={() => setEditing((value) => !value)}
          style={[styles.userTag, styles.addTag]}
        >
          {editing ? (
            <X color={tokens.green} size={13} strokeWidth={2.6} />
          ) : (
            <Plus color={tokens.green} size={13} strokeWidth={2.6} />
          )}
          <AppText size={12} weight="bold" color={tokens.green}>
            Tag
          </AppText>
        </Pressable>
      </View>

      {editing ? (
        <View style={styles.tagEditor}>
          {available.length > 0 ? (
            <View style={styles.tagRow}>
              {available.map((tag) => (
                <Pressable
                  key={tag}
                  accessibilityRole="button"
                  accessibilityLabel={`Add tag ${tag}`}
                  onPress={() => onAdd(record.id, tag)}
                  style={styles.userTag}
                >
                  <Plus color={tokens.textMuted} size={12} strokeWidth={2.6} />
                  <AppText size={12} weight="bold" color={tokens.textMuted}>
                    {tag}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.tagInputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={submitDraft}
              placeholder="Trail, trick, “best”…"
              placeholderTextColor={tokens.textMuted}
              autoCapitalize="none"
              returnKeyType="done"
              style={styles.tagInput}
            />
            <Button variant="secondary" onPress={submitDraft} style={styles.tagAddButton}>
              Add
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function RecordCard({ record, onShare, onShareLink, onRetry, onDelete, onReprocess, onAddTag, onRemoveTag, tagSuggestions, showTitle = true }: RecordCardProps) {
  const [detail, setDetail] = useState<JumpRecordDetail | undefined>();
  const [zoomed, setZoomed] = useState<FilmstripFrame | undefined>();
  const [mode, setMode] = useState<ViewerMode>("skeleton");
  const [fullscreen, setFullscreen] = useState(false);
  // Keeps the inline and fullscreen viewers on the same moment: whichever is
  // active reports its frame here; the other picks it up on (re)mount.
  const sharedFrameIndexRef = useRef(0);
  const [viewerEpoch, setViewerEpoch] = useState(0);
  const insets = useSafeAreaInsets();

  const openFullscreen = useCallback(() => {
    setFullscreen(true);
    // Remount the inline viewer paused at the shared frame while hidden.
    setViewerEpoch((epoch) => epoch + 1);
    // Fullscreen may rotate; the rest of the app stays portrait.
    void ScreenOrientation.unlockAsync();
  }, []);

  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    // Remount inline at wherever the fullscreen session ended.
    setViewerEpoch((epoch) => epoch + 1);
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, []);

  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setMode("skeleton");
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

  const statusTone = record.status === "ready" ? "green" : record.status === "failed" ? "red" : "amber";
  const statusLabel =
    record.status === "ready"
      ? "Ready"
      : record.status === "processing"
        ? "Processing"
        : record.status === "failed"
          ? "Failed"
          : "Queued";
  // Once the record is ready the status chip says nothing new — its header slot
  // becomes the lens toggle instead.
  const showModeToggle = record.status === "ready" && Boolean(record.clipUri) && frames.length > 0;

  return (
    <Card style={styles.card}>
      <View style={styles.headerRow}>
        {showTitle ? (
          <View style={styles.headerText}>
            <AppText weight="bold">{getRecordTitle(record)}</AppText>
            <AppText color={tokens.textMuted} size={12}>
              <NumberText size={12} color={tokens.textMuted}>
                {record.windowStart.toFixed(1)}s–{record.windowEnd.toFixed(1)}s
              </NumberText>
            </AppText>
          </View>
        ) : null}
        {showModeToggle ? (
          <View style={styles.segmented}>
            <SegmentButton
              icon={PersonStanding}
              label="Skeleton"
              active={mode === "skeleton"}
              onPress={() => setMode("skeleton")}
            />
            <SegmentButton icon={Film} label="Video" active={mode === "video"} onPress={() => setMode("video")} />
          </View>
        ) : (
          <Chip tone={statusTone}>{statusLabel}</Chip>
        )}
      </View>

      {onAddTag && onRemoveTag ? (
        <TagSection record={record} suggestions={tagSuggestions ?? []} onAdd={onAddTag} onRemove={onRemoveTag} />
      ) : null}

      {record.status === "ready" && detail && frames.length > 0 && !fullscreen ? (
        // Unmounted while fullscreen is open: two mounted viewers double the
        // decoded-image memory and Android's Fresco starts returning black
        // bitmaps. The viewer remounts at the shared frame on close.
        <JumpViewer
          key={`${record.id}-${viewerEpoch}-${mode}`}
          mode={mode}
          clipUri={record.clipUri}
          skeletonClipUri={record.skeletonClipUri}
          clipStartSeconds={record.windowStart}
          frames={frames}
          labels={labels}
          onZoom={setZoomed}
          initialFrameIndex={sharedFrameIndexRef.current}
          onFrameChange={(index) => {
            if (!fullscreen) sharedFrameIndexRef.current = index;
          }}
          onExpand={openFullscreen}
        />
      ) : null}

      {record.status === "ready" && detail && frames.length === 0 && record.clipUri ? (
        <ClipPlayer clipUri={record.clipUri} />
      ) : null}

      {record.status === "pending" || record.status === "failed" ? (
        <View style={styles.pendingRow}>
          <AlertTriangle color={tokens.amber} size={16} />
          <AppText size={13} color={tokens.textMuted} style={styles.pendingText}>
            {record.error ??
              (record.status === "failed"
                ? "Processing failed. Retry when the worker is reachable."
                : "Saved locally. RiderLens will process it when the worker is reachable.")}
          </AppText>
        </View>
      ) : null}

      {record.status === "ready" && record.flight ? (
        <View style={styles.flightStrip}>
          <View style={styles.flightStat}>
            <AppText size={10} weight="bold" color={tokens.textMuted} style={styles.flightLabel}>
              {record.flight.endedIn === "crash" ? "Air to impact" : "Airtime"}
            </AppText>
            <NumberText size={17} weight="bold">
              {record.flight.airtimeSeconds.toFixed(2)}s
            </NumberText>
          </View>
          {record.flight.heightMeters !== null ? (
            <View style={styles.flightStat}>
              <AppText size={10} weight="bold" color={tokens.textMuted} style={styles.flightLabel}>
                Height
              </AppText>
              <NumberText size={17} weight="bold">
                ~{record.flight.heightMeters.toFixed(1)}m
              </NumberText>
            </View>
          ) : null}
          <Chip tone="amber" style={styles.flightChip}>
            est.
          </Chip>
        </View>
      ) : null}

      <View style={styles.actions}>
        {record.status === "ready" && onShare ? (
          // Shares whichever lens is active: skeleton (watermarked) or clean clip.
          <Button
            icon={Share2}
            variant="secondary"
            size="sm"
            onPress={() => {
              const preferSkeleton = mode === "skeleton" && Boolean(record.skeletonClipUri);
              if (!onShareLink) {
                onShare(record, preferSkeleton);
                return;
              }
              Alert.alert("Share the send", "A link opens in any browser with frame stepping; the video file plays anywhere.", [
                { text: "Share link", onPress: () => onShareLink(record) },
                { text: "Share video", onPress: () => onShare(record, preferSkeleton) },
                { text: "Cancel", style: "cancel" }
              ]);
            }}
            style={styles.actionButton}
          >
            Share
          </Button>
        ) : null}
        {record.status === "ready" && onReprocess ? (
          <Button
            icon={RefreshCcw}
            variant="secondary"
            size="sm"
            accessibilityLabel="Reprocess this record"
            onPress={() => onReprocess(record)}
            style={styles.iconAction}
          />
        ) : null}
        {(record.status === "pending" || record.status === "failed") && onRetry ? (
          <Button icon={RefreshCcw} size="sm" onPress={() => onRetry(record)} style={styles.actionButton}>
            Retry
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            icon={Trash2}
            variant="secondary"
            size="sm"
            accessibilityLabel="Delete this record"
            onPress={() => onDelete(record)}
            style={styles.iconAction}
          />
        ) : null}
      </View>

      <Modal
        visible={fullscreen}
        animationType="fade"
        supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
        onRequestClose={closeFullscreen}
      >
        <View
          style={[
            styles.fullscreenRoot,
            {
              paddingTop: Math.max(insets.top, spacing.md),
              paddingBottom: Math.max(insets.bottom, spacing.md),
              paddingLeft: insets.left,
              paddingRight: insets.right
            }
          ]}
        >
          <View style={styles.fullscreenHeader}>
            {showModeToggle ? (
              <View style={styles.segmented}>
                <SegmentButton
                  icon={PersonStanding}
                  label="Skeleton"
                  active={mode === "skeleton"}
                  onPress={() => setMode("skeleton")}
                />
                <SegmentButton icon={Film} label="Video" active={mode === "video"} onPress={() => setMode("video")} />
              </View>
            ) : (
              <View />
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close fullscreen"
              onPress={closeFullscreen}
              style={styles.fullscreenClose}
            >
              <X color={tokens.surface} size={20} strokeWidth={2.4} />
            </Pressable>
          </View>
          {fullscreen && detail && frames.length > 0 ? (
            <JumpViewer
              key={`${record.id}-fullscreen-${mode}`}
              variant="fullscreen"
              mode={mode}
              clipUri={record.clipUri}
              skeletonClipUri={record.skeletonClipUri}
              clipStartSeconds={record.windowStart}
              frames={frames}
              labels={labels}
              onZoom={() => undefined}
              initialFrameIndex={sharedFrameIndexRef.current}
              onFrameChange={(index) => {
                if (fullscreen) sharedFrameIndexRef.current = index;
              }}
            />
          ) : null}
        </View>
      </Modal>

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
  viewer: {
    gap: spacing.sm
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: tokens.surfaceMuted,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  segmentActive: {
    backgroundColor: tokens.graphite
  },
  viewport: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: tokens.graphite
  },
  viewportImage: {
    width: "100%",
    height: "100%"
  },
  viewerFullscreen: {
    flex: 1,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  viewportFullscreen: {
    flex: 1,
    width: "100%",
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#000000"
  },
  frameStack: {
    flex: 1
  },
  frameHidden: {
    opacity: 0
  },
  expandButton: {
    position: "absolute",
    right: 8,
    bottom: 8,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: "rgba(16, 20, 17, 0.55)"
  },
  fullscreenRoot: {
    flex: 1,
    backgroundColor: "#0b0e0c"
  },
  fullscreenHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm
  },
  fullscreenClose: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: "rgba(255, 255, 255, 0.12)"
  },
  fallbackPlayer: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: "hidden",
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
  scrubber: {
    width: "100%",
    height: 40
  },
  playerControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  transportGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6
  },
  iconButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface
  },
  iconButtonEmphasis: {
    backgroundColor: tokens.electric,
    borderColor: tokens.electric
  },
  iconButtonPressed: {
    transform: [{ scale: 0.96 }]
  },
  speedButton: {
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 10
  },
  speedCaption: {
    letterSpacing: 0.4
  },
  playerTime: {
    minWidth: 42,
    textAlign: "right"
  },
  filmstripWrap: {
    width: "100%"
  },
  filmstrip: {
    gap: FILMSTRIP_GAP
  },
  playhead: {
    position: "absolute",
    top: -3,
    bottom: -3,
    left: "50%",
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: tokens.electric
  },
  filmstripCell: {
    alignItems: "center"
  },
  filmstripImage: {
    width: 114,
    height: 64,
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
  flightStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: radius.sm,
    backgroundColor: tokens.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  flightStat: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6
  },
  flightLabel: {
    textTransform: "uppercase"
  },
  flightChip: {
    marginLeft: "auto"
  },
  tagSection: {
    gap: spacing.sm
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm
  },
  userTag: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surfaceMuted,
    paddingHorizontal: 10
  },
  addTag: {
    backgroundColor: tokens.electricSoft,
    borderColor: tokens.electricSoft
  },
  tagEditor: {
    gap: spacing.sm
  },
  tagInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  tagInput: {
    flex: 1,
    minHeight: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: spacing.md,
    fontFamily: tokens.fontUi,
    fontSize: 14,
    color: tokens.text
  },
  tagAddButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md
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
    flex: 1
  },
  iconAction: {
    width: 46
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
