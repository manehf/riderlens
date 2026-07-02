import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Share } from "react-native";

import { demoGarage } from "../data/demoData";
import {
  applyManualFrameGeometry,
  createCalibrationMetrics,
  createId,
  createQueuedSession,
  createRuleBasedReport,
  formatReportShareText
} from "../services/analysis";
import { createSetupShareText } from "../services/setupShare";
import { analyzeRegularJumpWithWorker, type WorkerAnalysisResult } from "../services/analysisWorker";
import { persistClipReviewVideo } from "../services/videoLibrary";
import type { ClipReview, FrameGeometry, GarageState, PermissionLevel, RideSession, SkillType, ToolMeasurement } from "../types/domain";

const STORAGE_KEY = "riderlens:mvp-state:v1";

type PersistedState = {
  sessions: RideSession[];
  garage: GarageState;
  activeSessionId: string;
};

export type RiderLensStore = {
  sessions: RideSession[];
  garage: GarageState;
  activeSession?: RideSession;
  pendingClip?: ClipReview;
  selectSession: (sessionId: string) => void;
  selectedSkill: SkillType;
  setSelectedSkill: (skill: SkillType) => void;
  prepareClipFromUri: (uri: string, durationSeconds?: number) => void;
  updatePendingClip: (updates: Partial<Pick<ClipReview, "trimStartSeconds" | "trimEndSeconds" | "cropPreset">>) => void;
  confirmPendingClip: () => Promise<void>;
  cancelPendingClip: () => void;
  retryAnalysis: (sessionId: string) => void;
  startManualCalibration: (sessionId: string) => void;
  calibrateSessionFrame: (sessionId: string, metricId: string, geometry: FrameGeometry, frameTime?: number) => void;
  uploadVideoFromLibrary: () => Promise<void>;
  shareSessionReport: (sessionId: string) => Promise<void>;
  shareActiveReport: () => Promise<void>;
  shareSetupSheet: (permission?: PermissionLevel) => Promise<void>;
  saveSetupNote: (notes: string) => void;
  saveSuspensionValue: (field: "forkPressure" | "forkReboundClicks" | "forkLscClicks", value: number) => void;
  addMeasurement: (measurement: Omit<ToolMeasurement, "id" | "bikeId" | "bikeSetupId" | "createdAt">) => void;
};

function isSeedSession(session: RideSession): boolean {
  return session.id.startsWith("session-demo") || Boolean(session.video?.rawVideoUri.startsWith("demo://"));
}

// Drops legacy demo seeds and removed video-link reference sessions from persisted state.
function getUserSessions(sessions: RideSession[]): RideSession[] {
  return sessions.filter((session) => !isSeedSession(session) && Boolean(session.video));
}

function resolveActiveSessionId(sessions: RideSession[], activeSessionId?: string): string {
  if (activeSessionId && sessions.some((session) => session.id === activeSessionId)) {
    return activeSessionId;
  }
  return sessions[0]?.id ?? "";
}

export function useRiderLensMvp(): RiderLensStore {
  const [sessions, setSessions] = useState<RideSession[]>([]);
  const [garage, setGarage] = useState<GarageState>(demoGarage);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillType>("regular_jump");
  const [pendingClip, setPendingClip] = useState<ClipReview | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as PersistedState;
        const userSessions = getUserSessions(parsed.sessions ?? []);
        setSessions(userSessions);
        setGarage(parsed.garage);
        setActiveSessionId(resolveActiveSessionId(userSessions, parsed.activeSessionId));
      })
      .catch(() => {
        // Demo data is a safe fallback if local storage is unavailable.
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const payload: PersistedState = { sessions, garage, activeSessionId };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload)).catch(() => undefined);
  }, [activeSessionId, garage, hydrated, sessions]);

  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions]
  );

  const updateSession = useCallback((sessionId: string, updater: (session: RideSession) => RideSession) => {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
  }, []);

  const scheduleJobProgress = useCallback(
    (sessionId: string) => {
      const steps = [
        { delay: 350, progress: 0.18 },
        { delay: 900, progress: 0.42 },
        { delay: 1450, progress: 0.72 }
      ];

      steps.forEach((step) => {
        timers.current.push(
          setTimeout(() => {
            updateSession(sessionId, (session) => {
              if (
                session.status === "complete" ||
                session.status === "analysis_failed" ||
                session.job?.status === "completed" ||
                session.job?.status === "failed"
              ) {
                return session;
              }
              return {
                ...session,
                status: "analyzing",
                job: session.job
                  ? {
                      ...session.job,
                      status: "processing",
                      progress: step.progress
                    }
                  : session.job
              };
            });
          }, step.delay)
        );
      });
    },
    [updateSession]
  );

  const completeWithWorkerResult = useCallback(
    (sessionId: string, result: WorkerAnalysisResult) => {
      updateSession(sessionId, (session) => ({
        ...session,
        status: "complete",
        metrics: result.metrics,
        report: result.report,
        job: session.job
          ? {
              ...session.job,
              status: "completed",
              progress: 1,
              finishedAt: new Date().toISOString()
            }
          : undefined
      }));
    },
    [updateSession]
  );

  const failAnalysis = useCallback(
    (sessionId: string, message: string) => {
      updateSession(sessionId, (session) => ({
        ...session,
        status: "analysis_failed",
        job: session.job
          ? {
              ...session.job,
              status: "failed",
              errorMessage: message,
              finishedAt: new Date().toISOString()
            }
          : session.job
      }));
    },
    [updateSession]
  );

  const runMediaPipeJob = useCallback(
    (session: RideSession) => {
      scheduleJobProgress(session.id);

      void analyzeRegularJumpWithWorker(session)
        .then((result) => {
          if (result) {
            completeWithWorkerResult(session.id, result);
            return;
          }
          failAnalysis(
            session.id,
            "No analysis worker is configured. Set EXPO_PUBLIC_ANALYSIS_WORKER_URL, restart Expo, then retry."
          );
        })
        .catch((error: Error) => {
          failAnalysis(session.id, error.message || "The analysis worker could not process this clip.");
        });
    },
    [completeWithWorkerResult, failAnalysis, scheduleJobProgress]
  );

  const retryAnalysis = useCallback(
    (sessionId: string) => {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session || !session.video) return;

      const requeued: RideSession = {
        ...session,
        status: "analyzing",
        metrics: [],
        report: undefined,
        job: {
          id: createId("job"),
          sessionId: session.id,
          status: "queued",
          progress: 0,
          startedAt: new Date().toISOString()
        }
      };
      updateSession(sessionId, () => requeued);
      runMediaPipeJob(requeued);
    },
    [runMediaPipeJob, sessions, updateSession]
  );

  const startManualCalibration = useCallback(
    (sessionId: string) => {
      updateSession(sessionId, (session) => {
        if (session.metrics.length > 0) return session;
        return {
          ...session,
          metrics: createCalibrationMetrics(session)
        };
      });
    },
    [updateSession]
  );

  const prepareClipFromUri = useCallback((uri: string, durationSeconds = 6) => {
    const safeDuration = Math.max(3, Math.min(30, durationSeconds));
    const trimStartSeconds = safeDuration > 8 ? 1 : 0;
    const trimEndSeconds = Math.min(safeDuration, trimStartSeconds + 6);
    setPendingClip({
      uri,
      durationSeconds: safeDuration,
      trimStartSeconds,
      trimEndSeconds,
      cropPreset: "full_side_view"
    });
  }, []);

  const updatePendingClip = useCallback(
    (updates: Partial<Pick<ClipReview, "trimStartSeconds" | "trimEndSeconds" | "cropPreset">>) => {
      setPendingClip((current) => {
        if (!current) return current;
        const next: ClipReview = { ...current, ...updates };
        const minGap = 1;
        const trimStartSeconds = Math.max(0, Math.min(next.trimStartSeconds, next.durationSeconds - minGap));
        const trimEndSeconds = Math.max(
          trimStartSeconds + minGap,
          Math.min(next.trimEndSeconds, next.durationSeconds)
        );
        return {
          ...next,
          trimStartSeconds,
          trimEndSeconds
        };
      });
    },
    []
  );

  const confirmPendingClip = useCallback(async () => {
    if (!pendingClip) return;

    try {
      const storedClip = await persistClipReviewVideo(pendingClip);
      const session = createQueuedSession(selectedSkill, storedClip.uri, storedClip);
      setPendingClip(undefined);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      runMediaPipeJob(session);
    } catch {
      Alert.alert("Could not save video", "RiderLens could not copy this clip into the app library. Try selecting the video again.");
    }
  }, [pendingClip, runMediaPipeJob, selectedSkill]);

  const cancelPendingClip = useCallback(() => {
    setPendingClip(undefined);
  }, []);

  const calibrateSessionFrame = useCallback(
    (sessionId: string, metricId: string, geometry: FrameGeometry, frameTime?: number) => {
      updateSession(sessionId, (session) => {
        const metrics = session.metrics.map((metric) =>
          metric.id === metricId ? applyManualFrameGeometry(metric, geometry, frameTime) : metric
        );
        const hasVerifiedFrame = metrics.some(
          (metric) => metric.geometrySource === "manual" || metric.geometrySource === "detected"
        );

        return {
          ...session,
          status: hasVerifiedFrame ? "complete" : session.status,
          metrics,
          report: createRuleBasedReport(session, metrics)
        };
      });
    },
    [updateSession]
  );

  const uploadVideoFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Photo access needed", "Allow video library access to upload an existing riding clip.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsEditing: true,
      quality: 1,
      videoMaxDuration: 10
    });

    if (result.canceled) return;
    const asset = result.assets[0];
    const rawDuration = asset.duration ?? 6000;
    const durationSeconds = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
    prepareClipFromUri(asset.uri, durationSeconds);
  }, [prepareClipFromUri]);

  const shareSessionReport = useCallback(async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    await Share.share({
      title: "RiderLens coaching report",
      message: formatReportShareText(session)
    });
  }, [sessions]);

  const shareActiveReport = useCallback(async () => {
    if (!activeSession) return;
    await shareSessionReport(activeSession.id);
  }, [activeSession, shareSessionReport]);

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
    sessions,
    garage,
    activeSession,
    pendingClip,
    selectSession: setActiveSessionId,
    selectedSkill,
    setSelectedSkill,
    prepareClipFromUri,
    updatePendingClip,
    confirmPendingClip,
    cancelPendingClip,
    retryAnalysis,
    startManualCalibration,
    calibrateSessionFrame,
    uploadVideoFromLibrary,
    shareSessionReport,
    shareActiveReport,
    shareSetupSheet,
    saveSetupNote,
    saveSuspensionValue,
    addMeasurement
  };
}
