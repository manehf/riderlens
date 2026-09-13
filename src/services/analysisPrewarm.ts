import * as Sentry from "@sentry/react-native";
import { isAnalysisWorkerReachable, RecordForegroundWaitingError } from "./capture";

/** Optional warm-up runs alongside the picker, which can pause the activity.
 * It owns its rejection handler because the UI deliberately does not await it.
 * Actual analysis/recovery still handles foreground deferrals independently. */
export async function prewarmAnalysisWorker(): Promise<void> {
  try {
    await isAnalysisWorkerReachable();
  } catch (error) {
    if (error instanceof RecordForegroundWaitingError) return;
    Sentry.captureException(error, { tags: { workflow: "analysis", failure_stage: "worker_prewarm" } });
  }
}
