import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Share } from "react-native";

import { demoGarage } from "../data/demoData";
import { createId } from "../services/analysis";
import { isAnalysisWorkerReachable, processRecord, proposeWindow, type WindowProposal } from "../services/capture";
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

export type WindowStatus = "checking" | "ai" | "manual";

export type PendingCapture = {
  uri: string;
  durationSeconds: number;
  trimStartSeconds: number;
  trimEndSeconds: number;
  windowStatus: WindowStatus;
  proposal?: WindowProposal;
};

export type RiderLensStore = {
  records: JumpRecord[];
  pendingCapture?: PendingCapture;
  selectedSkill: SkillType;
  setSelectedSkill: (skill: SkillType) => void;
  startCaptureFromUri: (uri: string, durationSeconds?: number) => void;
  updatePendingWindow: (updates: Partial<Pick<PendingCapture, "trimStartSeconds" | "trimEndSeconds">>) => void;
  confirmPendingCapture: () => Promise<void>;
  cancelPendingCapture: () => void;
  retryRecord: (recordId: string) => void;
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
  recordVideoWithCamera: () => Promise<void>;
  garage: GarageState;
  shareSetupSheet: (permission?: PermissionLevel) => Promise<void>;
  saveSetupNote: (notes: string) => void;
  saveSuspensionValue: (field: "forkPressure" | "forkReboundClicks" | "forkLscClicks", value: number) => void;
  addMeasurement: (measurement: Omit<ToolMeasurement, "id" | "bikeId" | "bikeSetupId" | "createdAt">) => void;
};

const MIN_WINDOW_SECONDS = 0.5;

export function useRiderLensMvp(): RiderLensStore {
  const [records, setRecords] = useState<JumpRecord[]>([]);
  const [garage, setGarage] = useState<GarageState>(demoGarage);
  const [profile, setProfile] = useState<RiderProfile>(DEFAULT_PROFILE);
  const [selectedSkill, setSelectedSkill] = useState<SkillType>("regular_jump");
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | undefined>();
  const [hydrated, setHydrated] = useState(false);
  // Guards the async window proposal against a changed/cancelled pending clip.
  const pendingUriRef = useRef<string | undefined>(undefined);
  const recordsRef = useRef<JumpRecord[]>([]);
  const processingIdsRef = useRef<Set<string>>(new Set());
  const retryProbeActiveRef = useRef(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY).catch(() => null),
      // v1 held sessions + garage; carry the garage over once.
      AsyncStorage.getItem("riderlens:mvp-state:v1").catch(() => null),
      loadRecords()
    ])
      .then(([raw, legacyRaw, storedRecords]) => {
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedState;
          if (parsed.garage) setGarage(parsed.garage);
          if (parsed.profile) setProfile({ ...DEFAULT_PROFILE, ...parsed.profile });
        } else if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as { garage?: GarageState };
          if (legacy.garage) setGarage(legacy.garage);
        }
        setRecords(storedRecords);
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
    pendingUriRef.current = uri;
    setPendingCapture({
      uri,
      durationSeconds: safeDuration,
      trimStartSeconds: 0,
      trimEndSeconds: safeDuration,
      windowStatus: "checking"
    });

    // Ask the worker for an AI-proposed window; on timeout/unreachable/no-credentials
    // stay on manual with the full range. Never block the rider.
    void proposeWindow(uri).then((proposal) => {
      if (pendingUriRef.current !== uri) return;
      setPendingCapture((current) => {
        if (!current || current.uri !== uri) return current;
        const duration = proposal?.durationSeconds && proposal.durationSeconds > 0 ? proposal.durationSeconds : current.durationSeconds;
        if (proposal?.window) {
          return {
            ...current,
            durationSeconds: duration,
            trimStartSeconds: Math.max(0, Math.min(proposal.window.start, duration)),
            trimEndSeconds: Math.max(MIN_WINDOW_SECONDS, Math.min(proposal.window.end, duration)),
            windowStatus: "ai",
            proposal
          };
        }
        return { ...current, durationSeconds: duration, windowStatus: "manual", proposal };
      });
    });
  }, []);

  const updatePendingWindow = useCallback(
    (updates: Partial<Pick<PendingCapture, "trimStartSeconds" | "trimEndSeconds">>) => {
      setPendingCapture((current) => {
        if (!current) return current;
        const next = { ...current, ...updates };
        const trimStartSeconds = Math.max(0, Math.min(next.trimStartSeconds, next.durationSeconds - MIN_WINDOW_SECONDS));
        const trimEndSeconds = Math.max(
          trimStartSeconds + MIN_WINDOW_SECONDS,
          Math.min(next.trimEndSeconds, next.durationSeconds)
        );
        return { ...next, trimStartSeconds, trimEndSeconds };
      });
    },
    []
  );

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
        events: record.events
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
    if (!pendingCapture) return;

    let storedUri: string;
    try {
      storedUri = await persistVideoToLibrary(pendingCapture.uri);
    } catch {
      Alert.alert("Could not save video", "RiderLens could not copy this clip into the app library. Try again.");
      return;
    }

    const record: JumpRecord = {
      id: createId("record"),
      createdAt: new Date().toISOString(),
      skillType: selectedSkill,
      status: "pending",
      sourceVideoUri: storedUri,
      windowStart: pendingCapture.trimStartSeconds,
      windowEnd: pendingCapture.trimEndSeconds,
      aiWindow: pendingCapture.windowStatus === "ai",
      eventType: pendingCapture.proposal?.eventType,
      summary: pendingCapture.proposal?.summary,
      events: pendingCapture.proposal?.events
    };

    pendingUriRef.current = undefined;
    setPendingCapture(undefined);
    setRecords((current) => [record, ...current]);
    runRecordProcessing(record, pendingCapture.proposal?.uploadId);
  }, [pendingCapture, runRecordProcessing, selectedSkill]);

  const cancelPendingCapture = useCallback(() => {
    pendingUriRef.current = undefined;
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
  const recordVideoWithCamera = useCallback(async () => {
    if (!Device.isDevice) {
      Alert.alert(
        "No camera on the simulator",
        "Recording needs a real phone. Use Pick from library to test the flow here."
      );
      return;
    }
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Camera access needed",
        "Enable camera access in Settings to record clips, or pick a video from your library instead."
      );
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["videos"],
      videoMaxDuration: 30,
      // Caps camera output around 1080p on iOS — pose never needs 4K, and
      // uploads shrink 3-4x. The worker normalizes whatever gets through.
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.High
    });

    if (result.canceled) return;
    const asset = result.assets[0];
    const rawDuration = asset.duration ?? 6000;
    const durationSeconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
    startCaptureFromUri(asset.uri, durationSeconds);
  }, [startCaptureFromUri]);

  const uploadVideoFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow video library access to pick a riding clip.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      quality: 1,
      // iOS transcodes the picked video to 1080p H.264 on-device before we
      // ever see it; Android ignores this and relies on worker normalization.
      videoExportPreset: ImagePicker.VideoExportPreset.H264_1920x1080
    });

    if (result.canceled) return;
    const asset = result.assets[0];
    const rawDuration = asset.duration ?? 6000;
    const durationSeconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
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

  return {
    records,
    pendingCapture,
    selectedSkill,
    setSelectedSkill,
    startCaptureFromUri,
    updatePendingWindow,
    confirmPendingCapture,
    cancelPendingCapture,
    retryRecord,
    retryPendingRecords,
    deleteRecord,
    addRecordTag,
    removeRecordTag,
    knownTags,
    profile,
    saveProfile,
    shareRecordClip,
    uploadVideoFromLibrary,
    recordVideoWithCamera,
    garage,
    shareSetupSheet,
    saveSetupNote,
    saveSuspensionValue,
    addMeasurement
  };
}
