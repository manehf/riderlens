import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Share } from "react-native";

import { demoGarage } from "../data/demoData";
import { createId } from "../services/analysis";
import { processRecord, proposeWindow, type WindowProposal } from "../services/capture";
import {
  deleteRecordFiles,
  loadRecords,
  persistRecordPayload,
  saveRecords
} from "../services/recordStore";
import { createSetupShareText } from "../services/setupShare";
import { persistVideoToLibrary } from "../services/videoLibrary";
import type { GarageState, JumpRecord, PermissionLevel, SkillType, ToolMeasurement } from "../types/domain";

const STORAGE_KEY = "riderlens:mvp-state:v2";

type PersistedState = {
  garage: GarageState;
};

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
  activeRecord?: JumpRecord;
  selectRecord: (recordId: string) => void;
  pendingCapture?: PendingCapture;
  selectedSkill: SkillType;
  setSelectedSkill: (skill: SkillType) => void;
  startCaptureFromUri: (uri: string, durationSeconds?: number) => void;
  updatePendingWindow: (updates: Partial<Pick<PendingCapture, "trimStartSeconds" | "trimEndSeconds">>) => void;
  confirmPendingCapture: () => Promise<void>;
  cancelPendingCapture: () => void;
  retryRecord: (recordId: string) => void;
  deleteRecord: (recordId: string) => void;
  shareRecordClip: (record: JumpRecord) => Promise<void>;
  uploadVideoFromLibrary: () => Promise<void>;
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
  const [activeRecordId, setActiveRecordId] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillType>("regular_jump");
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | undefined>();
  const [hydrated, setHydrated] = useState(false);
  // Guards the async window proposal against a changed/cancelled pending clip.
  const pendingUriRef = useRef<string | undefined>(undefined);

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
        } else if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as { garage?: GarageState };
          if (legacy.garage) setGarage(legacy.garage);
        }
        setRecords(storedRecords);
        setActiveRecordId(storedRecords[0]?.id ?? "");
      })
      .catch(() => undefined)
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ garage } satisfies PersistedState)).catch(() => undefined);
  }, [garage, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveRecords(records).catch(() => undefined);
  }, [hydrated, records]);

  const activeRecord = useMemo(
    () => records.find((record) => record.id === activeRecordId) ?? records[0],
    [activeRecordId, records]
  );

  const updateRecord = useCallback((recordId: string, updater: (record: JumpRecord) => JumpRecord) => {
    setRecords((current) => current.map((record) => (record.id === recordId ? updater(record) : record)));
  }, []);

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
      updateRecord(record.id, (current) => ({ ...current, status: "processing", error: undefined }));

      void processRecord({
        videoUri: record.sourceVideoUri,
        uploadId,
        startSeconds: record.windowStart,
        endSeconds: record.windowEnd,
        events: record.events
      })
        .then(async (payload) => {
          const { clipUri } = await persistRecordPayload(record.id, payload);
          updateRecord(record.id, (current) => ({
            ...current,
            status: "ready",
            clipUri,
            windowStart: payload.window.start,
            windowEnd: payload.window.end,
            events: payload.events.length > 0 ? payload.events : current.events,
            error: undefined
          }));
        })
        .catch((error: Error) => {
          updateRecord(record.id, (current) => ({
            ...current,
            status: "pending",
            error: error.message || "Processing failed. Retry when connected."
          }));
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
    setActiveRecordId(record.id);
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

  const deleteRecord = useCallback((recordId: string) => {
    setRecords((current) => current.filter((record) => record.id !== recordId));
    void deleteRecordFiles(recordId);
  }, []);

  const shareRecordClip = useCallback(async (record: JumpRecord) => {
    if (record.clipUri && (await Sharing.isAvailableAsync())) {
      await Sharing.shareAsync(record.clipUri, { mimeType: "video/mp4", dialogTitle: "Share your jump" });
      return;
    }
    await Share.share({
      title: "RiderLens record",
      message: record.summary ?? "My jump, captured with RiderLens."
    });
  }, []);

  const uploadVideoFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow video library access to pick a riding clip.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      quality: 1
    });

    if (result.canceled) return;
    const asset = result.assets[0];
    const rawDuration = asset.duration ?? 6000;
    const durationSeconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
    startCaptureFromUri(asset.uri, durationSeconds);
  }, [startCaptureFromUri]);

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
    activeRecord,
    selectRecord: setActiveRecordId,
    pendingCapture,
    selectedSkill,
    setSelectedSkill,
    startCaptureFromUri,
    updatePendingWindow,
    confirmPendingCapture,
    cancelPendingCapture,
    retryRecord,
    deleteRecord,
    shareRecordClip,
    uploadVideoFromLibrary,
    garage,
    shareSetupSheet,
    saveSetupNote,
    saveSuspensionValue,
    addMeasurement
  };
}
