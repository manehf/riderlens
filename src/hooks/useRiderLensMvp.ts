import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Share } from "react-native";

import { demoGarage } from "../data/demoData";
import { useProStatus } from "./useProStatus";
import { createId } from "../services/analysis";
import {
  consumeFreeAnalysis,
  FREE_ANALYSIS_LIMIT,
  getFreeAnalysesRemaining,
  loadFreeAllowance,
  saveFreeAllowance,
  usedThisMonth,
  type FreeAllowance
} from "../services/analysisAllowance";
import { isAnalysisWorkerReachable, processRecord } from "../services/capture";
import {
  createInitialAnalysisWindow,
  fitAnalysisWindow,
  MIN_ANALYSIS_WINDOW_SECONDS,
  updateAnalysisWindow
} from "../services/captureWindow";
import {
  backfillPoster,
  deleteRecordFiles,
  loadRecords,
  persistRecordPayload,
  saveRecords
} from "../services/recordStore";
import { createSetupShareText } from "../services/setupShare";
import { deleteLibraryVideo, persistVideoToLibrary } from "../services/videoLibrary";
import type { GarageState, JumpRecord, PermissionLevel, RiderProfile, SkillType, ToolMeasurement } from "../types/domain";

const STORAGE_KEY = "riderlens:mvp-state:v2";
const AUTO_RETRY_INTERVAL_MS = 30_000;

type PersistedState = {
  garage: GarageState;
  profile?: RiderProfile;
};

// Metric and right-foot-forward are the common cases; both stay one tap to change.
const DEFAULT_PROFILE: RiderProfile = { units: "metric", leadFoot: "right" };

export type PendingCapture = {
  uri: string;
  durationSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  /** Clockwise display/processing rotation the rider dialed in (0/90/180/270). */
  rotateDegrees: number;
  /** Set when this capture rebuilds an existing record instead of creating one. */
  reprocessRecordId?: string;
};

export type AnalysisAccess = {
  available: boolean;
  ready: boolean;
  isPro: boolean;
  freeLimit: number;
  freeUsed: number;
  freeRemaining: number;
  upgrade: () => Promise<boolean>;
  restore: () => Promise<boolean>;
};

export type RiderLensStore = {
  records: JumpRecord[];
  pendingCapture?: PendingCapture;
  selectedSkill: SkillType;
  setSelectedSkill: (skill: SkillType) => void;
  startCaptureFromUri: (uri: string, durationSeconds?: number) => void;
  updatePendingWindow: (updates: Partial<Pick<PendingCapture, "trimStartSeconds" | "trimEndSeconds">>) => void;
  updatePendingDuration: (durationSeconds: number) => void;
  /** Rotate the pending clip 90° clockwise (cycles back to 0 after 270). */
  rotatePendingCapture: () => void;
  /** Returns true when a record was created/reprocessed. A cancelled paywall
   * leaves the trim sheet open and returns false. */
  confirmPendingCapture: () => Promise<boolean>;
  cancelPendingCapture: () => void;
  retryRecord: (recordId: string) => void;
  /** Reopen the trim sheet for an existing record (kept source video) to fix
   * rotation or the window; confirming rebuilds the record in place. */
  reprocessRecord: (recordId: string) => void;
  /** Probe the worker and re-run all queued/failed records now (pull-to-refresh). */
  retryPendingRecords: () => Promise<void>;
  deleteRecord: (recordId: string) => void;
  addRecordTag: (recordId: string, tag: string) => void;
  removeRecordTag: (recordId: string, tag: string) => void;
  /** Distinct rider-added tags across all records, for one-tap suggestions. */
  knownTags: string[];
  profile: RiderProfile;
  saveProfile: (updates: Partial<RiderProfile>) => void;
  shareRecordClip: (record: JumpRecord, preferSkeleton?: boolean) => Promise<void>;
  uploadVideoFromLibrary: () => Promise<void>;
  analysisAccess: AnalysisAccess;
  garage: GarageState;
  shareSetupSheet: (permission?: PermissionLevel) => Promise<void>;
  saveSetupNote: (notes: string) => void;
  saveSuspensionValue: (field: "forkPressure" | "forkReboundClicks" | "forkLscClicks", value: number) => void;
  addMeasurement: (measurement: Omit<ToolMeasurement, "id" | "bikeId" | "bikeSetupId" | "createdAt">) => void;
};

// Bound source uploads for the MVP. The rider then selects one jump, up to
// eight seconds, inside RiderLens before any network upload begins.
const LIBRARY_MAX_SECONDS = 30;

export function useRiderLensMvp(): RiderLensStore {
  const pro = useProStatus();
  const [records, setRecords] = useState<JumpRecord[]>([]);
  const [garage, setGarage] = useState<GarageState>(demoGarage);
  const [profile, setProfile] = useState<RiderProfile>(DEFAULT_PROFILE);
  const [selectedSkill, setSelectedSkill] = useState<SkillType>("regular_jump");
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | undefined>();
  const [freeAllowance, setFreeAllowance] = useState<FreeAllowance | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const recordsRef = useRef<JumpRecord[]>([]);
  const freeAllowanceRef = useRef<FreeAllowance | undefined>(undefined);
  const processingIdsRef = useRef<Set<string>>(new Set());
  const retryProbeActiveRef = useRef(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY).catch(() => null),
      // v1 held sessions + garage; carry the garage over once.
      AsyncStorage.getItem("riderlens:mvp-state:v1").catch(() => null),
      loadRecords(),
      loadFreeAllowance()
    ])
      .then(([raw, legacyRaw, storedRecords, storedAllowance]) => {
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedState;
          if (parsed.garage) setGarage(parsed.garage);
          if (parsed.profile) setProfile({ ...DEFAULT_PROFILE, ...parsed.profile });
        } else if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as { garage?: GarageState };
          if (legacy.garage) setGarage(legacy.garage);
        }
        setRecords(storedRecords);
        freeAllowanceRef.current = storedAllowance;
        setFreeAllowance(storedAllowance);
      })
      .catch(() => undefined)
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ garage, profile } satisfies PersistedState)).catch(() => undefined);
  }, [garage, hydrated, profile]);

  useEffect(() => {
    if (!hydrated) return;
    saveRecords(records).catch(() => undefined);
  }, [hydrated, records]);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const updateRecord = useCallback((recordId: string, updater: (record: JumpRecord) => JumpRecord) => {
    setRecords((current) => current.map((record) => (record.id === recordId ? updater(record) : record)));
  }, []);

  // Records processed before posters existed get one generated from their stored
  // filmstrip, once, in the background.
  const backfilledRef = useRef(false);
  useEffect(() => {
    if (!hydrated || backfilledRef.current) return;
    backfilledRef.current = true;
    for (const record of records) {
      if (record.status !== "ready" || record.posterUri) continue;
      void backfillPoster(record.id)
        .then((posterUri) => {
          if (posterUri) updateRecord(record.id, (current) => ({ ...current, posterUri }));
        })
        .catch(() => undefined);
    }
  }, [hydrated, records, updateRecord]);

  const startCaptureFromUri = useCallback((uri: string, durationSeconds = 6) => {
    const safeDuration = Math.max(1, durationSeconds);
    const initialWindow = createInitialAnalysisWindow(safeDuration);
    setPendingCapture({
      uri,
      durationSeconds: safeDuration,
      trimStartSeconds: initialWindow.start,
      trimEndSeconds: initialWindow.end,
      rotateDegrees: 0
    });
  }, []);

  const reprocessRecord = useCallback(
    (recordId: string) => {
      const record = records.find((item) => item.id === recordId);
      if (!record || record.status === "processing") return;
      const uri = record.sourceVideoUri;
      const seedDuration = record.sourceDurationSeconds ?? Math.max(record.windowEnd + 1, MIN_ANALYSIS_WINDOW_SECONDS + 1);
      const seedWindow = fitAnalysisWindow(record.windowStart, record.windowEnd, seedDuration);
      setPendingCapture({
        uri,
        durationSeconds: seedDuration,
        trimStartSeconds: seedWindow.start,
        trimEndSeconds: seedWindow.end,
        rotateDegrees: record.rotateDegrees ?? 0,
        reprocessRecordId: record.id
      });
    },
    [records]
  );

  const updatePendingWindow = useCallback(
    (updates: Partial<Pick<PendingCapture, "trimStartSeconds" | "trimEndSeconds">>) => {
      setPendingCapture((current) => {
        if (!current) return current;
        const window = updateAnalysisWindow(
          { start: current.trimStartSeconds, end: current.trimEndSeconds },
          { start: updates.trimStartSeconds, end: updates.trimEndSeconds },
          current.durationSeconds
        );
        return { ...current, trimStartSeconds: window.start, trimEndSeconds: window.end };
      });
    },
    []
  );

  const updatePendingDuration = useCallback((durationSeconds: number) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    setPendingCapture((current) => {
      if (!current || Math.abs(current.durationSeconds - durationSeconds) < 0.05) return current;
      const window = fitAnalysisWindow(current.trimStartSeconds, current.trimEndSeconds, durationSeconds);
      return {
        ...current,
        durationSeconds,
        trimStartSeconds: window.start,
        trimEndSeconds: window.end
      };
    });
  }, []);

  const authorizeNewAnalysis = useCallback(async (): Promise<"pro" | "free" | undefined> => {
    if (!hydrated) return undefined;

    let entitled = pro.isPro;
    if (pro.available && !pro.ready) {
      entitled = await pro.refresh();
    }
    if (entitled) return "pro";
    if (getFreeAnalysesRemaining(freeAllowanceRef.current) > 0) return "free";

    if (!pro.available) {
      // Purchases can't open in this build (Expo Go / no store keys), so a
      // paywall here would be a dead end. Never brick the rider: let the
      // analysis through and say so. Store builds carry keys, so this path
      // only exists in test/dev builds.
      Alert.alert(
        "Free limit reached",
        "Upgrades aren't available in this test build, so this analysis is on us. The store version unlocks unlimited analyses with RiderLens Pro."
      );
      return "free";
    }

    return (await pro.upgrade()) ? "pro" : undefined;
  }, [hydrated, pro.available, pro.isPro, pro.ready, pro.refresh, pro.upgrade]);

  const runRecordProcessing = useCallback(
    (record: JumpRecord, uploadId?: string) => {
      if (processingIdsRef.current.has(record.id)) return;
      processingIdsRef.current.add(record.id);
      updateRecord(record.id, (current) => ({ ...current, status: "processing", error: undefined }));

      void processRecord({
        videoUri: record.sourceVideoUri,
        uploadId,
        startSeconds: record.windowStart,
        endSeconds: record.windowEnd,
        events: record.events,
        rotateDegrees: record.rotateDegrees
      })
        .then(async (payload) => {
          const { clipUri, skeletonClipUri, posterUri } = await persistRecordPayload(record.id, payload);
          updateRecord(record.id, (current) => ({
            ...current,
            status: "ready",
            clipUri,
            skeletonClipUri,
            posterUri,
            windowStart: payload.window.start,
            windowEnd: payload.window.end,
            events: payload.events.length > 0 ? payload.events : current.events,
            flight: payload.flight ?? undefined,
            error: undefined
          }));
        })
        .catch((error: Error) => {
          updateRecord(record.id, (current) => ({
            ...current,
            status: "pending",
            error: error.message || "Processing failed. Retry when connected."
          }));
        })
        .finally(() => {
          processingIdsRef.current.delete(record.id);
        });
    },
    [updateRecord]
  );

  const confirmPendingCapture = useCallback(async () => {
    if (!pendingCapture) return false;

    if (pendingCapture.reprocessRecordId) {
      const existing = records.find((item) => item.id === pendingCapture.reprocessRecordId);
      if (existing) {
        const updated: JumpRecord = {
          ...existing,
          status: "pending",
          windowStart: pendingCapture.trimStartSeconds,
          windowEnd: pendingCapture.trimEndSeconds,
          sourceDurationSeconds: pendingCapture.durationSeconds,
          rotateDegrees: pendingCapture.rotateDegrees || undefined,
          aiWindow: false,
          eventType: undefined,
          summary: undefined,
          events: undefined,
          flight: undefined,
          error: undefined
        };
        setPendingCapture(undefined);
        setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        runRecordProcessing(updated);
        return true;
      }
    }

    const access = await authorizeNewAnalysis();
    if (!access) return false;

    let storedUri: string;
    try {
      storedUri = await persistVideoToLibrary(pendingCapture.uri);
    } catch {
      Alert.alert("Could not save video", "RiderLens could not copy this clip into the app library. Try again.");
      return false;
    }

    const record: JumpRecord = {
      id: createId("record"),
      createdAt: new Date().toISOString(),
      skillType: selectedSkill,
      status: "pending",
      sourceVideoUri: storedUri,
      sourceDurationSeconds: pendingCapture.durationSeconds,
      windowStart: pendingCapture.trimStartSeconds,
      windowEnd: pendingCapture.trimEndSeconds,
      aiWindow: false,
      rotateDegrees: pendingCapture.rotateDegrees || undefined
    };

    setPendingCapture(undefined);
    setRecords((current) => [record, ...current]);
    if (access === "free") {
      const next = consumeFreeAnalysis(freeAllowanceRef.current);
      freeAllowanceRef.current = next;
      setFreeAllowance(next);
      await saveFreeAllowance(next).catch(() => undefined);
    }
    runRecordProcessing(record);
    return true;
  }, [authorizeNewAnalysis, pendingCapture, records, runRecordProcessing, selectedSkill]);

  const rotatePendingCapture = useCallback(() => {
    setPendingCapture((current) =>
      current ? { ...current, rotateDegrees: (current.rotateDegrees + 90) % 360 } : current
    );
  }, []);

  const cancelPendingCapture = useCallback(() => {
    setPendingCapture(undefined);
  }, []);

  const retryRecord = useCallback(
    (recordId: string) => {
      const record = records.find((item) => item.id === recordId);
      if (!record || record.status === "processing" || record.status === "ready") return;
      runRecordProcessing(record);
    },
    [records, runRecordProcessing]
  );

  const retryPendingRecords = useCallback(async () => {
    if (retryProbeActiveRef.current) return;
    const retryable = recordsRef.current.filter((record) => record.status === "pending" || record.status === "failed");
    if (retryable.length === 0) return;

    retryProbeActiveRef.current = true;
    try {
      if (!(await isAnalysisWorkerReachable())) return;
      for (const record of retryable) {
        runRecordProcessing(record);
      }
    } finally {
      retryProbeActiveRef.current = false;
    }
  }, [runRecordProcessing]);

  useEffect(() => {
    if (!hydrated) return;
    void retryPendingRecords();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void retryPendingRecords();
    });
    const interval = setInterval(() => {
      if (AppState.currentState === "active") void retryPendingRecords();
    }, AUTO_RETRY_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [hydrated, retryPendingRecords]);

  const deleteRecord = useCallback((recordId: string) => {
    setRecords((current) => {
      const record = current.find((item) => item.id === recordId);
      // Each confirm copies the source fresh (1:1 mapping), so deleting the
      // record can safely take its original with it — no orphaned videos.
      if (record) void deleteLibraryVideo(record.sourceVideoUri);
      return current.filter((item) => item.id !== recordId);
    });
    void deleteRecordFiles(recordId);
  }, []);

  const addRecordTag = useCallback(
    (recordId: string, tag: string) => {
      const cleaned = tag.trim();
      if (!cleaned) return;
      updateRecord(recordId, (current) => {
        const existing = current.tags ?? [];
        if (existing.some((item) => item.toLowerCase() === cleaned.toLowerCase())) return current;
        return { ...current, tags: [...existing, cleaned] };
      });
    },
    [updateRecord]
  );

  const removeRecordTag = useCallback(
    (recordId: string, tag: string) => {
      updateRecord(recordId, (current) => ({
        ...current,
        tags: (current.tags ?? []).filter((item) => item !== tag)
      }));
    },
    [updateRecord]
  );

  const knownTags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const record of records) {
      for (const tag of record.tags ?? []) {
        const key = tag.toLowerCase();
        if (!seen.has(key)) seen.set(key, tag);
      }
    }
    return [...seen.values()];
  }, [records]);

  // Share whichever lens is active: the skeleton version carries the watermark
  // and QR end-card (the growth loop), the clean clip is just the footage.
  const shareRecordClip = useCallback(async (record: JumpRecord, preferSkeleton = false) => {
    const uri = preferSkeleton && record.skeletonClipUri ? record.skeletonClipUri : record.clipUri;
    if (uri) {
      if (Platform.OS === "ios") {
        // File + message together: targets that accept text (Messages, Mail,
        // Telegram) include the link; media-only targets (WhatsApp, IG) keep
        // just the video — which is why the link is also burned into it.
        await Share.share({ url: uri, message: "Filmed with RiderLens — https://riderlens.app" });
        return;
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "video/mp4", dialogTitle: "Share the moment" });
        return;
      }
    }
    await Share.share({
      title: "RiderLens record",
      message: "Captured with RiderLens — https://riderlens.app"
    });
  }, []);

  // The native system camera (via the image picker) beats any embedded
  // viewfinder: full-screen preview, zoom, exposure, flash — and it hands back
  // a file exactly like the library path.
  const uploadVideoFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow video library access to pick a riding clip.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      quality: 1,
      // RiderLens owns the single trim step after picking; opening the iOS
      // editor here created two competing selection experiences.
      allowsEditing: false,
      // iOS transcodes the picked video to 1080p H.264 on-device before we
      // ever see it; Android ignores this and relies on worker normalization.
      videoExportPreset: ImagePicker.VideoExportPreset.H264_1920x1080
    });

    if (result.canceled) return;
    const asset = result.assets[0];
    const rawDuration = asset.duration ?? 6000;
    const durationSeconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
    if (durationSeconds > LIBRARY_MAX_SECONDS) {
      Alert.alert(
        "Long video",
        "Choose a clip under 30 seconds, then select the moment inside RiderLens.",
        [{ text: "OK" }]
      );
      return;
    }
    startCaptureFromUri(asset.uri, durationSeconds);
  }, [startCaptureFromUri]);

  const saveProfile = useCallback((updates: Partial<RiderProfile>) => {
    setProfile((current) => ({ ...current, ...updates }));
  }, []);

  const shareSetupSheet = useCallback(
    async (permission: PermissionLevel = "view") => {
      await Share.share({
        title: "RiderLens setup sheet",
        message: createSetupShareText(garage, permission)
      });
    },
    [garage]
  );

  const saveSetupNote = useCallback((notes: string) => {
    setGarage((current) => ({
      ...current,
      setup: {
        ...current.setup,
        notes,
        updatedAt: new Date().toISOString()
      }
    }));
  }, []);

  const saveSuspensionValue = useCallback(
    (field: "forkPressure" | "forkReboundClicks" | "forkLscClicks", value: number) => {
      setGarage((current) => ({
        ...current,
        setup: {
          ...current.setup,
          updatedAt: new Date().toISOString()
        },
        suspension: {
          ...current.suspension,
          [field]: value
        }
      }));
    },
    []
  );

  const addMeasurement = useCallback(
    (measurement: Omit<ToolMeasurement, "id" | "bikeId" | "bikeSetupId" | "createdAt">) => {
      setGarage((current) => ({
        ...current,
        measurements: [
          {
            ...measurement,
            id: createId("measure"),
            bikeId: current.bike.id,
            bikeSetupId: current.setup.id,
            createdAt: new Date().toISOString()
          },
          ...current.measurements
        ]
      }));
    },
    []
  );

  const analysisAccess = useMemo<AnalysisAccess>(
    () => ({
      available: pro.available,
      ready: hydrated && (!pro.available || pro.ready),
      isPro: pro.isPro,
      freeLimit: FREE_ANALYSIS_LIMIT,
      freeUsed: usedThisMonth(freeAllowance),
      freeRemaining: getFreeAnalysesRemaining(freeAllowance),
      upgrade: pro.upgrade,
      restore: pro.restore
    }),
    [freeAllowance, hydrated, pro.available, pro.isPro, pro.ready, pro.restore, pro.upgrade]
  );

  return {
    records,
    pendingCapture,
    selectedSkill,
    setSelectedSkill,
    startCaptureFromUri,
    updatePendingWindow,
    updatePendingDuration,
    rotatePendingCapture,
    confirmPendingCapture,
    cancelPendingCapture,
    retryRecord,
    reprocessRecord,
    retryPendingRecords,
    deleteRecord,
    addRecordTag,
    removeRecordTag,
    knownTags,
    profile,
    saveProfile,
    shareRecordClip,
    uploadVideoFromLibrary,
    analysisAccess,
    garage,
    shareSetupSheet,
    saveSetupNote,
    saveSuspensionValue,
    addMeasurement
  };
}
