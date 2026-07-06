import Slider from "@react-native-community/slider";
import { useEventListener } from "expo";
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
import { Image, Modal, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { getRecordTitle, getSystemTags } from "../services/analysis";
import { loadRecordDetail } from "../services/recordStore";
import { radius, spacing, tokens } from "../theme/tokens";
import type { FilmstripFrame, JumpRecord, JumpRecordDetail } from "../types/domain";
import { AppText, Button, Card, Chip, NumberText } from "./ui";

type RecordCardProps = {
  record: JumpRecord;
  onShare?: (record: JumpRecord, preferSkeleton?: boolean) => void;
  onRetry?: (record: JumpRecord) => void;
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

// Default playback is half speed: slow enough to read body position, fast enough
// to feel motion. The speed button cycles through these for both lenses.
const PLAYBACK_SPEEDS = [1, 0.5, 0.25];
const DEFAULT_SPEED = 0.5;

function speedLabel(speed: number): string {
  return speed === 1 ? "1×" : speed === 0.5 ? "½×" : "¼×";
}

type ViewerMode = "skeleton" | "video";

/** True double-buffered frame display. Two image views stay permanently
 * mounted: the incoming frame decodes in the hidden one, and only an opacity
 * flip (instant, no decode) reveals it. Nothing ever unmounts, so there is
 * never an empty native view — no black between frames. Under fast playback
 * a slow decode skips a frame instead of flashing. */
function FrameImage({ frame }: { frame: FilmstripFrame }) {
  const [slotA, setSlotA] = useState(frame);
  const [slotB, setSlotB] = useState(frame);
  const [showA, setShowA] = useState(true);
  const pendingImageRef = useRef<string | null>(null);

  useEffect(() => {
    const shown = showA ? slotA : slotB;
    if (frame.image === shown.image) return;
    // Load the incoming frame into whichever slot is hidden right now.
    pendingImageRef.current = frame.image;
    if (showA) {
      setSlotB(frame);
    } else {
      setSlotA(frame);
    }
    // Reacts to the target frame only; slots/showA are read, not triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  function handleLoaded(slot: "A" | "B", image: string) {
    if (pendingImageRef.current !== image) return;
    pendingImageRef.current = null;
    setShowA(slot === "A");
  }

  return (
    <View style={styles.frameStack}>
      <Image
        source={{ uri: slotA.image }}
        style={[StyleSheet.absoluteFill, !showA && styles.frameHidden]}
        resizeMode="contain"
        fadeDuration={0}
        onLoadEnd={() => handleLoaded("A", slotA.image)}
      />
      <Image
        source={{ uri: slotB.image }}
        style={[StyleSheet.absoluteFill, showA && styles.frameHidden]}
        resizeMode="contain"
        fadeDuration={0}
        onLoadEnd={() => handleLoaded("B", slotB.image)}
      />
    </View>
  );
}

type JumpViewerProps = {
  /** Owned by RecordCard: the toggle lives in the card header. */
  mode: ViewerMode;
  clipUri?: string;
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
  clipStartSeconds,
  frames,
  labels,
  onZoom,
  variant = "card",
  initialFrameIndex = 0,
  onFrameChange,
  onExpand
}: JumpViewerProps) {
  const [frameIndex, setFrameIndex] = useState(() => Math.min(initialFrameIndex, Math.max(0, frames.length - 1)));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  // In landscape fullscreen every vertical point goes to the footage.
  const compactControls = variant === "fullscreen" && windowWidth > windowHeight;

  const player = useVideoPlayer(clipUri ?? null, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.playbackRate = DEFAULT_SPEED;
    instance.timeUpdateEventInterval = 0.15;
  });

  // One speed for both lenses.
  useEffect(() => {
    if (clipUri) player.playbackRate = speed;
  }, [clipUri, player, speed]);

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

  // Skeleton playback: step through frames on a timer.
  useEffect(() => {
    if (mode !== "skeleton" || !playing || frames.length < 2) return;
    const timer = setInterval(() => {
      setFrameIndex((index) => (index + 1) % frames.length);
    }, frameIntervalMs);
    return () => clearInterval(timer);
  }, [mode, playing, frames.length, frameIntervalMs]);

  // Video playback follows the shared `playing` flag.
  useEffect(() => {
    if (!clipUri) return;
    if (mode === "video" && playing) {
      player.play();
    } else {
      player.pause();
    }
  }, [clipUri, mode, playing, player]);

  // While the video plays, keep frameIndex (slider + strip highlight) in sync.
  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    if (mode !== "video" || frames.length === 0) return;
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
    setFrameIndex(best);
  });

  const seekToFrame = useCallback(
    (index: number) => {
      setPlaying(false);
      setFrameIndex(index);
      const frame = frames[index];
      if (frame && clipUri) {
        player.currentTime = clipTimeOf(frame);
      }
    },
    [clipTimeOf, clipUri, frames, player]
  );

  // Carry the current moment across mode switches so the toggle never jumps in time.
  const frameIndexRef = useRef(frameIndex);
  frameIndexRef.current = frameIndex;
  const previousModeRef = useRef(mode);
  useEffect(() => {
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    if (mode === "video" && clipUri) {
      const frame = frames[frameIndexRef.current];
      if (frame) player.currentTime = clipTimeOf(frame);
    }
  }, [clipTimeOf, clipUri, frames, mode, player]);

  // Start the video at the initial frame (matters when opening fullscreen mid-scrub).
  useEffect(() => {
    const frame = frames[frameIndexRef.current];
    if (clipUri && frame) player.currentTime = clipTimeOf(frame);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onFrameChange?.(frameIndex);
  }, [frameIndex, onFrameChange]);

  const currentFrame = frames[Math.min(frameIndex, frames.length - 1)];
  // Pre-decode the next frame so playback never waits on the JPEG decoder.
  const nextFrame = frames[(Math.min(frameIndex, frames.length - 1) + 1) % frames.length];

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
        {mode === "video" && clipUri ? (
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
        ) : (
          <Pressable style={StyleSheet.absoluteFill} onPress={() => onZoom(currentFrame)}>
            <FrameImage frame={currentFrame} />
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

      {nextFrame && mode === "skeleton" ? (
        // Invisible 1px image: keeps the decoder one frame ahead of playback.
        <Image source={{ uri: nextFrame.image }} style={styles.framePrefetch} />
      ) : null}

      {/* The scrubber gets its own full-width row: easy to grab and slide. */}
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

      <View style={styles.playerControls}>
        <View style={styles.transportGroup}>
          <IconButton
            icon={ChevronLeft}
            label="Previous frame"
            onPress={() => seekToFrame(Math.max(0, frameIndex - 1))}
          />
          <IconButton
            icon={playing ? Pause : Play}
            label={playing ? "Pause" : "Play"}
            emphasis
            onPress={() => setPlaying((value) => !value)}
          />
          <IconButton
            icon={ChevronRight}
            label="Next frame"
            onPress={() => seekToFrame(Math.min(frames.length - 1, frameIndex + 1))}
          />
        </View>
        <View style={styles.transportGroup}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Playback speed ${speedLabel(speed)}`}
            onPress={cycleSpeed}
            style={styles.speedButton}
          >
            <NumberText size={12} weight="bold">
              {speedLabel(speed)}
            </NumberText>
          </Pressable>
          <NumberText size={11} color={tokens.textMuted} style={styles.playerTime}>
            {currentFrame.t.toFixed(2)}s
          </NumberText>
        </View>
      </View>

      {compactControls ? null : (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filmstrip}>
        {frames.map((frame, index) => (
          <Pressable key={frame.t} onPress={() => seekToFrame(index)} style={styles.filmstripCell}>
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
          </Pressable>
        ))}
      </ScrollView>
      )}
    </View>
  );
}

type IconButtonProps = {
  icon: typeof Film;
  label: string;
  onPress: () => void;
  emphasis?: boolean;
};

function IconButton({ icon: Icon, label, onPress, emphasis = false }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
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

export function RecordCard({ record, onShare, onRetry, onDelete, onAddTag, onRemoveTag, tagSuggestions }: RecordCardProps) {
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
        <View style={styles.headerText}>
          <AppText weight="bold">{getRecordTitle(record)}</AppText>
          <AppText color={tokens.textMuted} size={12}>
            <NumberText size={12} color={tokens.textMuted}>
              {record.windowStart.toFixed(1)}s–{record.windowEnd.toFixed(1)}s
            </NumberText>
            {record.aiWindow ? " · AI window" : " · manual window"}
          </AppText>
        </View>
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

      {record.status === "ready" && detail && frames.length > 0 ? (
        // The series (detail.series) is still measured and stored; the timeline
        // chart is hidden until the coaching layer can interpret it. MVP shows
        // the self-explanatory lens: skeleton on every frame.
        <JumpViewer
          key={`${record.id}-${viewerEpoch}`}
          mode={mode}
          clipUri={record.clipUri}
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
            onPress={() => onShare(record, mode === "skeleton" && Boolean(record.skeletonClipUri))}
            style={styles.actionButton}
          >
            {mode === "skeleton" && record.skeletonClipUri ? "Share skeleton" : "Share clip"}
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
              key={`${record.id}-fullscreen`}
              variant="fullscreen"
              mode={mode}
              clipUri={record.clipUri}
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
  framePrefetch: {
    position: "absolute",
    width: 1,
    height: 1,
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
    minWidth: 40,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: 6
  },
  playerTime: {
    minWidth: 42,
    textAlign: "right"
  },
  filmstrip: {
    gap: spacing.sm
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
