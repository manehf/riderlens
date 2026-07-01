import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Share } from "react-native";

import { demoGarage } from "../data/demoData";
import {
  applyManualFrameGeometry,
  completeLocalAnalysis,
  createId,
  createLinkReferenceSession,
  createQueuedSession,
  createRuleBasedReport,
  formatReportShareText,
  isSupportedVideoLink
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
  analyzeVideoLink: (url: string) => boolean;
  prepareClipFromUri: (uri: string, durationSeconds?: number) => void;
  updatePendingClip: (updates: Partial<Pick<ClipReview, "trimStartSeconds" | "trimEndSeconds" | "cropPreset">>) => void;
  confirmPendingClip: () => Promise<void>;
  cancelPendingClip: () => void;
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

function getUserSessions(sessions: RideSession[]): RideSession[] {
  return sessions.filter((session) => !isSeedSession(session)).map(normalizeStoredSession);
}

function normalizeStoredSession(session: RideSession): RideSession {
  if (session.source !== "video_link") {
    return session;
  }

  const title = session.title.includes("reference") ? session.title : session.title.replace("jump analysis", "reference");
  const notes = "Reference link only. Upload the original clip file for MediaPipe frame geometry.";
  if (
    session.status === "reference" &&
    session.title === title &&
    !session.job &&
    session.metrics.length === 0 &&
    !session.report &&
    session.linkReference?.notes === notes
  ) {
    return session;
  }

  return {
    ...session,
    status: "reference",
    title,
    job: undefined,
    metrics: [],
    report: undefined,
    linkReference: session.linkReference
      ? {
          ...session.linkReference,
          notes
        }
      : undefined
  };
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
    if (!hydrated) return;

    setSessions((current) => {
      const normalized = current.map(normalizeStoredSession);
      return normalized.some((session, index) => session !== current[index]) ? normalized : current;
    });
  }, [hydrated]);

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
              if (session.status === "complete" || session.job?.status === "completed") return session;
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

  const runLocalJob = useCallback(
    (sessionId: string) => {
      scheduleJobProgress(sessionId);

      timers.current.push(
        setTimeout(() => {
          updateSession(sessionId, completeLocalAnalysis);
        }, 2100)
      );
    },
    [scheduleJobProgress, updateSession]
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
          updateSession(session.id, completeLocalAnalysis);
        })
        .catch((error: Error) => {
          updateSession(session.id, completeLocalAnalysis);
          Alert.alert(
            "MediaPipe analysis unavailable",
            `${error.message || "The analysis worker could not process this clip."} You can still use manual calibration and try again later.`
          );
        });
    },
    [completeWithWorkerResult, scheduleJobProgress, updateSession]
  );

  const analyzeVideoLink = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (!isSupportedVideoLink(trimmed)) {
        Alert.alert("Invalid link", "Paste a full video URL, such as a YouTube link starting with https://.");
        return false;
      }

      const session = createLinkReferenceSession(selectedSkill, trimmed);
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      Alert.alert("Reference saved", "Upload the original video file when you want MediaPipe geometry and jump-frame analysis.");
      return true;
    },
    [selectedSkill]
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

        return {
          ...session,
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
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
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
    analyzeVideoLink,
    prepareClipFromUri,
    updatePendingClip,
    confirmPendingClip,
    cancelPendingClip,
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
