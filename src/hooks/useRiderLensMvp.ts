import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Sentry from "@sentry/react-native";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform, Share } from "react-native";

import { demoGarage } from "../data/demoData";
import { useProStatus } from "./useProStatus";
import { createId } from "../services/analysis";
import {
  consumeFreeAnalysis,
  currentAllowanceMonth,
  FREE_ANALYSIS_LIMIT,
  getFreeAnalysesRemaining,
  loadFreeAllowance,
  saveFreeAllowance,
  usedThisMonth,
  type FreeAllowance
} from "../services/analysisAllowance";
import {
  createShareLink,
  isAnalysisWorkerReachable,
  processRecord,
  RecordProcessingError,
  RecordReadTimeoutError,
  RecordWaitingError,
  RecordJobFailedError,
  RecordTransferWaitingError,
  RecordSubmissionFallbackError,
  RecordForegroundWaitingError,
  WorkerResponseError
} from "../services/capture";
import {
  createInitialAnalysisWindow,
  fitAnalysisWindow,
  MIN_ANALYSIS_WINDOW_SECONDS,
  updateAnalysisWindow
} from "../services/captureWindow";
import { isInterruptedVideoImport, isLikelyFragmentedMp4 } from "../services/videoFormat";
import { trackAnalysisEvent, trackBillingEvent } from "../services/productAnalytics";
import { analysisRequestId, analysisRetryDelay, isCurrentAnalysisAttempt, SerialAnalysisQueue } from "../services/analysisRetry";
import { getAnalysisTransport } from "../services/analysisTransport";
import { consumeTransferReceipt, reconcileAnalysisTransfers, transferDiagnostics, transferPhase } from "../services/analysisCoordinator";
import {
  backfillPoster,
  beginRecordDeletion,
  finishRecordDeletion,
  loadRecordDeletions,
  deleteRecordFiles,
  deleteRecordPayload,
  loadRecords,
  persistRecordPayload,
  saveRecords
} from "../services/recordStore";
import { createSetupShareText } from "../services/setupShare";
import { deleteLibraryVideo, persistVideoToLibrary } from "../services/videoLibrary";
import type { GarageState, JumpRecord, PermissionLevel, RiderProfile, SkillType, ToolMeasurement } from "../types/domain";

const STORAGE_KEY = "riderlens:mvp-state:v2";
const AUTO_RETRY_INTERVAL_MS = 5_000;

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
  exportRecordVideo: (record: JumpRecord, preferSkeleton?: boolean) => Promise<void>;
  shareRecordLink: (record: JumpRecord) => Promise<void>;
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
  const [records, applyRecords] = useState<JumpRecord[]>([]);
  const [garage, setGarage] = useState<GarageState>(demoGarage);
  const [profile, setProfile] = useState<RiderProfile>(DEFAULT_PROFILE);
  const [selectedSkill, setSelectedSkill] = useState<SkillType>("regular_jump");
  const [pendingCapture, setPendingCapture] = useState<PendingCapture | undefined>();
  const [freeAllowance, setFreeAllowance] = useState<FreeAllowance | undefined>();
  const [hydrated, setHydrated] = useState(false);
  const recordsRef = useRef<JumpRecord[]>([]);
  const freeAllowanceRef = useRef<FreeAllowance | undefined>(undefined);
  const processingIdsRef = useRef<Set<string>>(new Set());
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const analysisQueueRef = useRef(new SerialAnalysisQueue());
  const workerRetryAtRef = useRef(0);
  // Keep queue decisions synchronous with every record mutation, including creation.
  const setRecords = useCallback((update: JumpRecord[] | ((current: JumpRecord[]) => JumpRecord[])) => {
    const next = typeof update === "function" ? update(recordsRef.current) : update;
    recordsRef.current = next;
    applyRecords(next);
  }, []);
  const retryProbeActiveRef = useRef(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY).catch(() => null),
      // v1 held sessions + garage; carry the garage over once.
      AsyncStorage.getItem("riderlens:mvp-state:v1").catch(() => null),
      loadRecords(),
      loadFreeAllowance(),
      loadRecordDeletions()
    ])
      .then(([raw, legacyRaw, storedRecords, storedAllowance, deletions]) => {
        if (raw) {
          const parsed = JSON.parse(raw) as PersistedState;
          if (parsed.garage) setGarage(parsed.garage);
          if (parsed.profile) setProfile({ ...DEFAULT_PROFILE, ...parsed.profile });
        } else if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) as { garage?: GarageState };
          if (legacy.garage) setGarage(legacy.garage);
        }
        setRecords(storedRecords.filter((record) => !deletions.some((item) => item.id === record.id)));
        workerRetryAtRef.current = Math.max(0, ...storedRecords.map((record) => record.analysisWorkerRetryAt ?? 0));
        freeAllowanceRef.current = storedAllowance;
        setFreeAllowance(storedAllowance);
        setHydrated(true);
      })
      .catch((error) => {
        Sentry.captureException(error, { tags: { workflow: "analysis", failure_stage: "local_load" } });
        Alert.alert("Could not load saved analyses", "Please reopen RiderLens to try again. Your saved files have not been changed.");
      });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ garage, profile } satisfies PersistedState)).catch(() => undefined);
  }, [garage, hydrated, profile]);

  useEffect(() => {
    if (!hydrated) return;
    saveRecords(recordsRef.current).catch(() => undefined);
  }, [hydrated, records]);

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
      void backfillPoster(record.id, record.detailUri)
        .then((posterUri) => {
          if (posterUri) updateRecord(record.id, (current) =>
            current.detailUri === record.detailUri && analysisRequestId(current) === analysisRequestId(record)
              ? { ...current, posterUri } : current);
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
      if (!record || record.status === "processing" || processingIdsRef.current.has(recordId)) return;
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

    return (await pro.upgrade({
      paywall_source: "monthly_limit",
      allowance_month: currentAllowanceMonth(),
      free_used: usedThisMonth(freeAllowanceRef.current),
      free_limit: FREE_ANALYSIS_LIMIT,
      free_remaining: 0
    })) ? "pro" : undefined;
  }, [hydrated, pro.available, pro.isPro, pro.ready, pro.refresh, pro.upgrade]);

  const runRecordProcessing = useCallback(
    (record: JumpRecord, uploadId?: string, retrySource?: "manual" | "automatic", consumeReceipt = false) => {
      void analysisQueueRef.current.enqueue(record.id, async () => {
        const current = recordsRef.current.find((item) => item.id === record.id);
        if (!current || deletingIdsRef.current.has(record.id) || current.status === "ready" || AppState.currentState !== "active") return;
        if (!consumeReceipt && (current.analysisNextRetryAt ?? 0) > Date.now()) return;
        if (!consumeReceipt && !current.analysisJobId && !current.analysisTransferId && workerRetryAtRef.current > Date.now()) {
          updateRecord(current.id, (item) => ({ ...item, analysisNextRetryAt: workerRetryAtRef.current, error: "Waiting for analysis availability. RiderLens will retry automatically." }));
          return;
        }
        if (!consumeReceipt && retrySource === "automatic" && current.analysisRetryable === false) return;
        record = current;
        const requestId = analysisRequestId(record);
        const attemptIsCurrent = () => !deletingIdsRef.current.has(record.id) && isCurrentAnalysisAttempt(recordsRef.current.find((item) => item.id === record.id), requestId);
        processingIdsRef.current.add(record.id);
        const eventContext = {
          skill_type: record.skillType,
          clip_duration_seconds: Number((record.windowEnd - record.windowStart).toFixed(1)),
          is_retry: Boolean(retrySource),
          retry_source: retrySource
        };
        // Polling is ordinary progress, not a new analysis attempt or failure.
        if (retrySource && !record.analysisJobId && !record.analysisTransferId && !consumeReceipt) {
          trackAnalysisEvent("analysis_retry", record.id, eventContext);
        }
        updateRecord(record.id, (item) => ({
          ...item, analysisAttemptId: requestId,
          status: record.analysisJobId ? "pending" : "processing",
          error: record.analysisJobId ? item.error : undefined
        }));
        let savingLocally = true;
        try {
          // Save the attempt key before upload so a restart can recover it.
          await saveRecords(recordsRef.current);
          if (!attemptIsCurrent()) return;
          savingLocally = false;
          const payload = await processRecord({
            videoUri: record.sourceVideoUri,
            uploadId,
            requestId,
            recoverCompleted: Boolean(retrySource),
            jobId: record.analysisJobId,
            legacySubmission: record.analysisLegacySubmission,
            canSubmit: () => attemptIsCurrent() && AppState.currentState === "active",
            onPhase: (analysisPhase) => { if (attemptIsCurrent()) updateRecord(record.id, (item) => ({ ...item, analysisPhase })); },
            startSeconds: record.windowStart,
            endSeconds: record.windowEnd,
            events: record.events,
            rotateDegrees: record.rotateDegrees
          });
          savingLocally = true;
          if (!attemptIsCurrent()) return;
          updateRecord(record.id, (item) => ({ ...item, analysisPhase: "downloading" }));
          const { clipUri, skeletonClipUri, posterUri, detailUri } = await persistRecordPayload(record.id, payload, requestId);
          if (!attemptIsCurrent()) {
            await deleteRecordPayload(record.id, detailUri);
            return;
          }
          updateRecord(record.id, (item) => ({
            ...item,
            status: "ready", clipUri, skeletonClipUri, posterUri, detailUri,
            windowStart: payload.window.start,
            windowEnd: payload.window.end,
            events: payload.events.length > 0 ? payload.events : item.events,
            flight: payload.flight ?? undefined,
            error: undefined,
            analysisJobId: undefined,
            analysisTransferId: undefined,
            analysisPhase: undefined,
            analysisUploadProgress: undefined,
            analysisRetryCount: undefined,
            analysisNextRetryAt: undefined,
            analysisWorkerRetryAt: undefined,
            analysisRetryable: undefined
          }));
          await saveRecords(recordsRef.current);
          if (record.detailUri && record.detailUri !== detailUri) {
            // Cleanup failure does not turn a durably ready analysis into failed.
            await deleteRecordPayload(record.id, record.detailUri).catch((error) => {
              Sentry.captureException(error, { tags: { workflow: "analysis", failure_stage: "payload_cleanup" } });
            });
          }
          trackAnalysisEvent("analysis_completed", record.id, {
            ...eventContext, has_skeleton_video: Boolean(skeletonClipUri), filmstrip_frame_count: payload.filmstrip.length
          });
        } catch (error) {
          if (!attemptIsCurrent()) return;
          const waiting = error instanceof RecordWaitingError;
          const transferring = error instanceof RecordTransferWaitingError;
          const fallback = error instanceof RecordSubmissionFallbackError;
          const deferred = error instanceof RecordForegroundWaitingError;
          const snapshot = error instanceof RecordProcessingError ? error.transfer : undefined;
          const busy = error instanceof WorkerResponseError && error.status === 429;
          const retryable = error instanceof RecordProcessingError ? error.retryable : true;
          const attempts = waiting || transferring || fallback || deferred ? (record.analysisRetryCount ?? 0) : (record.analysisRetryCount ?? 0) + 1;
          const delay = waiting || transferring || fallback || deferred
            ? (error.retryAfterMs ?? 10_000)
            : analysisRetryDelay(attempts, error instanceof RecordProcessingError ? error.retryAfterMs : undefined);
          const retryAt = Date.now() + delay;
          if (busy) workerRetryAtRef.current = Math.max(workerRetryAtRef.current, retryAt);
          updateRecord(record.id, (item) => ({
            ...item,
            status: transferring && snapshot ? "processing" : retryable ? "pending" : "failed",
            error: error instanceof Error ? error.message : "Processing failed. Retry when connected.",
            analysisJobId: waiting ? error.jobId : transferring || fallback || error instanceof RecordJobFailedError ? undefined : item.analysisJobId,
            analysisTransferId: transferring ? snapshot?.transferId : undefined,
            analysisPhase: transferring && snapshot ? transferPhase(snapshot) : waiting ? error.phase : deferred && item.analysisJobId ? "queued" : undefined,
            analysisUploadProgress: transferring && snapshot && snapshot.bytesExpected > 0
              ? Math.min(1, snapshot.bytesSent / snapshot.bytesExpected) : undefined,
            analysisLegacySubmission: fallback ? error.legacySubmission : item.analysisLegacySubmission,
            analysisRetryCount: attempts,
            analysisNextRetryAt: retryable ? retryAt : undefined,
            analysisWorkerRetryAt: busy ? workerRetryAtRef.current : item.analysisWorkerRetryAt,
            analysisRetryable: retryable
          }));
          // Persist the acknowledgement and deadline before releasing the queue;
          // correctness must not depend on React's next persistence effect.
          await consumeTransferReceipt(getAnalysisTransport(), snapshot, () => saveRecords(recordsRef.current));
          if (!attemptIsCurrent()) return;
          if (waiting || busy || transferring || fallback || deferred) {
            // Avoid a breadcrumb every five seconds while the same upload runs.
            if (!transferring || record.analysisPhase !== (snapshot && transferPhase(snapshot))) {
              Sentry.addBreadcrumb({ category: "analysis", level: "info", message: deferred ? "Analysis check deferred until foreground" : transferring ? "Analysis upload active" : waiting ? "Analysis queued" : fallback ? "Analysis transport fallback" : "Analysis worker busy", data: { recordId: record.id, requestId, retryAt, ...transferDiagnostics(snapshot) } });
            }
          } else {
            const failureStage = savingLocally ? "local_save" : error instanceof RecordProcessingError ? error.failureStage : "unknown_analysis";
            trackAnalysisEvent("analysis_failed", record.id, { ...eventContext, failure_stage: failureStage });
            Sentry.captureException(error, {
              tags: { workflow: "analysis", failure_stage: failureStage, retry_source: retrySource ?? "initial" },
              extra: {
                recordId: record.id, requestId, phase: record.analysisPhase, skillType: record.skillType,
                clipDurationSeconds: eventContext.clip_duration_seconds, appState: AppState.currentState, retryable,
                ...transferDiagnostics(snapshot),
                ...(error instanceof RecordReadTimeoutError ? {
                  readOperation: error.operation, readTimeoutMs: error.timeoutMs, readElapsedMs: error.elapsedMs
                } : {})
              }
            });
          }
        } finally {
          processingIdsRef.current.delete(record.id);
        }
      }).catch((error) => Sentry.captureException(error, { tags: { workflow: "analysis", failure_stage: "local_queue" } }));
    },
    [updateRecord]
  );

  const confirmPendingCapture = useCallback(async () => {
    if (!pendingCapture) return false;

    if (pendingCapture.reprocessRecordId) {
      const existing = records.find((item) => item.id === pendingCapture.reprocessRecordId);
      if (existing) {
        // A selection may have opened before a poll started. Prevent replacing
        // its attempt while that poll can be writing media to the same folder.
        if (processingIdsRef.current.has(existing.id)) {
          Alert.alert("Analysis is updating", "Please try again when this analysis update finishes.");
          return false;
        }
        const updated: JumpRecord = {
          ...existing,
          analysisAttemptId: createId("analysis"),
          analysisJobId: undefined,
          analysisTransferId: undefined,
          analysisPhase: undefined,
          analysisUploadProgress: undefined,
          analysisLegacySubmission: undefined,
          analysisRetryCount: undefined,
          analysisNextRetryAt: undefined,
          analysisRetryable: undefined,
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
        trackAnalysisEvent("analysis_started", updated.id, {
          skill_type: updated.skillType,
          clip_duration_seconds: Number((updated.windowEnd - updated.windowStart).toFixed(1)),
          source_duration_seconds: Number(pendingCapture.durationSeconds.toFixed(1)),
          is_reprocess: true
        });
        setPendingCapture(undefined);
        setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        runRecordProcessing(updated);
        return true;
      }
    }

    const access = await authorizeNewAnalysis();
    if (!access) return false;

    const recordId = createId("record");
    const eventContext = {
      skill_type: selectedSkill,
      clip_duration_seconds: Number((pendingCapture.trimEndSeconds - pendingCapture.trimStartSeconds).toFixed(1)),
      source_duration_seconds: Number(pendingCapture.durationSeconds.toFixed(1)),
      is_reprocess: false
    };
    trackAnalysisEvent("analysis_started", recordId, eventContext);

    let storedUri: string;
    try {
      storedUri = await persistVideoToLibrary(pendingCapture.uri);
    } catch (error) {
      trackAnalysisEvent("analysis_failed", recordId, {
        ...eventContext,
        failure_stage: "source_save"
      });
      Sentry.captureException(error, {
        tags: { workflow: "analysis", failure_stage: "source_save" },
        extra: {
          recordId,
          skillType: selectedSkill,
          clipDurationSeconds: eventContext.clip_duration_seconds
        }
      });
      Alert.alert("Could not save video", "RiderLens could not copy this clip into the app library. Try again.");
      return false;
    }

    const record: JumpRecord = {
      id: recordId,
      analysisAttemptId: createId("analysis"),
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
      const previousRemaining = getFreeAnalysesRemaining(freeAllowanceRef.current);
      const next = consumeFreeAnalysis(freeAllowanceRef.current);
      freeAllowanceRef.current = next;
      setFreeAllowance(next);
      await saveFreeAllowance(next).catch(() => undefined);
      if (pro.available && previousRemaining > 0 && getFreeAnalysesRemaining(next) === 0) {
        trackBillingEvent("allowance_exhausted", {
          allowance_month: next.month, free_used: next.used,
          free_limit: FREE_ANALYSIS_LIMIT, free_remaining: 0
        });
      }
    }
    runRecordProcessing(record);
    return true;
  }, [authorizeNewAnalysis, pendingCapture, pro.available, records, runRecordProcessing, selectedSkill]);

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
      let record = records.find((item) => item.id === recordId);
      if (!record || record.status === "processing" || record.status === "ready") return;
      if (record.analysisRetryable === false) {
        record = { ...record, analysisAttemptId: createId("analysis"), analysisJobId: undefined, analysisTransferId: undefined, analysisPhase: undefined, analysisUploadProgress: undefined, analysisLegacySubmission: undefined, analysisRetryable: undefined, analysisRetryCount: undefined, analysisNextRetryAt: undefined };
        updateRecord(record.id, () => record!);
      }
      runRecordProcessing(record, undefined, "manual");
    },
    [records, runRecordProcessing, updateRecord]
  );

  const retryPendingRecords = useCallback(async () => {
    if (retryProbeActiveRef.current || AppState.currentState !== "active") return;
    retryProbeActiveRef.current = true;
    try {
      const deletions = await loadRecordDeletions();
      if (deletions.length) {
        setRecords((current) => current.filter((record) => !deletions.some((item) => item.id === record.id)));
        await saveRecords(recordsRef.current);
      }
      const transport = getAnalysisTransport();
      const transfers = transport
        ? await reconcileAnalysisTransfers(transport, () => recordsRef.current, () => saveRecords(recordsRef.current), () => AppState.currentState === "active") : [];
      for (const deletion of deletions) {
        // A superseded attempt can still own the same source; wait for all native
        // readers, including orphan cancellation, before removing library files.
        if (processingIdsRef.current.has(deletion.id) || transfers.some((task) => task.state !== "terminal")) continue;
        await deleteRecordFiles(deletion.id);
        await deleteLibraryVideo(deletion.sourceVideoUri);
        await finishRecordDeletion(deletion.id);
        deletingIdsRef.current.delete(deletion.id);
      }
      const receipts = new Set(transfers.filter((task) => task.state === "terminal").map((task) => task.attemptId));
      const live = new Set(transfers.filter((task) => task.state !== "terminal").map((task) => task.attemptId));
      const retryable = recordsRef.current.filter((record) => record.status !== "ready" && (
        receipts.has(analysisRequestId(record)) || live.has(analysisRequestId(record)) ||
        ((record.status === "pending" || record.status === "failed" || Boolean(transport) && record.status === "processing") &&
          record.analysisRetryable !== false && (record.analysisNextRetryAt ?? 0) <= Date.now())
      ));
      if (!retryable.length) return;
      if (!transport && !(await isAnalysisWorkerReachable())) return;
      for (const record of retryable) {
        runRecordProcessing(record, undefined, "automatic", receipts.has(analysisRequestId(record)) || live.has(analysisRequestId(record)));
      }
    } catch (error) {
      if (error instanceof RecordForegroundWaitingError) return;
      Sentry.captureException(error, { tags: { workflow: "analysis", failure_stage: "transfer_reconciliation" } });
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
    const record = recordsRef.current.find((item) => item.id === recordId);
    if (!record || deletingIdsRef.current.has(recordId)) return;
    deletingIdsRef.current.add(recordId);
    void (async () => {
      // The intent survives a crash before index removal or native cancellation.
      await beginRecordDeletion({ id: record.id, sourceVideoUri: record.sourceVideoUri, attemptId: analysisRequestId(record) });
      setRecords((current) => current.filter((item) => item.id !== recordId));
      await saveRecords(recordsRef.current);
      await retryPendingRecords();
    })().catch((error) => {
      deletingIdsRef.current.delete(recordId);
      Sentry.captureException(error, { tags: { workflow: "analysis", failure_stage: "record_delete" } });
      Alert.alert("Deletion could not finish", "RiderLens will try again when you reopen the app.");
    });
  }, [retryPendingRecords]);

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

  // Export whichever lens is active. Distribution uses the hosted share page;
  // this remains a secondary utility for social posts and offline file use.
  const exportRecordVideo = useCallback(async (record: JumpRecord, preferSkeleton = false) => {
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

  const shareRecordLink = useCallback(
    async (record: JumpRecord) => {
      try {
        let url = record.shareUrl;
        if (!url) {
          const uri = record.skeletonClipUri ?? record.clipUri;
          if (!uri) {
            Alert.alert("Nothing to share yet", "This record has no processed clip.");
            return;
          }
          url = await createShareLink(uri, record.flight?.airtimeSeconds, profile.name);
          const shareUrl = url;
          updateRecord(record.id, (current) => ({ ...current, shareUrl }));
        }
        await Share.share({ message: `You have to see this send \u{1F440} ${url}` });
      } catch (error) {
        Alert.alert(
          "Couldn't create the link",
          error instanceof Error ? error.message : "Check your connection and retry."
        );
      }
    },
    [profile.name, updateRecord]
  );

  // The native system camera (via the image picker) beats any embedded
  // viewfinder: full-screen preview, zoom, exposure, flash — and it hands back
  // a file exactly like the library path.
  const uploadVideoFromLibrary = useCallback(async () => {
    try {
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
        // Keep the original representation. The worker already normalizes
        // orientation, dimensions, and codec, so an extra iOS export only adds
        // latency, temporary storage pressure, and another failure point.
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current
      });

      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) {
        Alert.alert("Couldn't open video", "No video was returned. Choose the clip again.");
        return;
      }

      // Streaming containers (fragmented MP4) scrub unreliably in the trim
      // preview even though analysis normalizes them fine — warn, don't block.
      void isLikelyFragmentedMp4(asset.uri).then((fragmented) => {
        if (fragmented) {
          Alert.alert(
            "Streaming-format video",
            "This clip uses a streaming container, so the preview may not scrub smoothly. The analysis itself will still work."
          );
        }
      });
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
    } catch (error) {
      const interrupted = isInterruptedVideoImport(error);
      Alert.alert(
        interrupted ? "Video import interrupted" : "Couldn't open video",
        interrupted
          ? "iOS stopped preparing this video. Keep RiderLens open and try again. If it is stored in iCloud, open it in Photos first so it finishes downloading."
          : "RiderLens couldn't read this video. Try another clip or export a copy from Photos."
      );
    }
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
    exportRecordVideo,
    shareRecordLink,
    uploadVideoFromLibrary,
    analysisAccess,
    garage,
    shareSetupSheet,
    saveSetupNote,
    saveSuspensionValue,
    addMeasurement
  };
}
