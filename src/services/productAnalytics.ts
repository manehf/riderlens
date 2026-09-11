import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

import { initializeMetaAppEvents, logMetaAppEvent, type MetaAppEventParameters } from "./metaAppEvents";
import { sendAnalyticsEventToWorker, type BillingEventName, type WorkerAnalyticsEvent } from "./capture";

export type AnalysisEventName = Exclude<WorkerAnalyticsEvent["name"], BillingEventName>;
export type AnalysisEventParameters = MetaAppEventParameters;

const QUEUE_KEY = "riderlens:product-analytics:v1";
const MAX_QUEUE_SIZE = 100;
const MAX_EVENT_AGE_MS = 71 * 60 * 60 * 1000;
const appSessionId = Math.floor(Date.now() / 1000);
// Billing counts describe events/sessions, never distinct customers. Do not
// join RevenueCat customer identifiers or advertising IDs into GA4.
const billingSessionId = `billing.${createEventId()}`;
let serializedWork: Promise<unknown> = Promise.resolve();

function schedule<T>(work: () => Promise<T>): Promise<T> {
  const next = serializedWork.then(work, work);
  serializedWork = next.catch(() => undefined);
  return next;
}

function createEventId(): string {
  return `event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeParameters(parameters: AnalysisEventParameters): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(parameters).filter((entry) => entry[1] !== undefined)) as Record<
    string,
    string | number | boolean
  >;
}

async function loadQueue(): Promise<WorkerAnalyticsEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkerAnalyticsEvent[];
    const oldestAllowed = (Date.now() - MAX_EVENT_AGE_MS) * 1000;
    return parsed.filter((event) => event.timestampMicros >= oldestAllowed).slice(-MAX_QUEUE_SIZE);
  } catch {
    return [];
  }
}

async function saveQueue(queue: WorkerAnalyticsEvent[]): Promise<void> {
  if (queue.length === 0) {
    await AsyncStorage.removeItem(QUEUE_KEY);
    return;
  }
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_SIZE)));
}

async function flushQueue(queue?: WorkerAnalyticsEvent[]): Promise<void> {
  const remaining = [...(queue ?? (await loadQueue()))];
  while (remaining.length > 0) {
    try {
      await sendAnalyticsEventToWorker(remaining[0]);
      remaining.shift();
      await saveQueue(remaining);
    } catch {
      await saveQueue(remaining);
      return;
    }
  }
}

/** Initialize campaign attribution and retry any GA4 events queued offline. */
export async function initializeProductAnalytics(): Promise<void> {
  await initializeMetaAppEvents();
  await schedule(() => flushQueue());
}

/**
 * Record an analysis funnel event in Meta and GA4. Meta receives only the
 * minimal event parameters; GA4 additionally receives a random analysis ID as
 * its client_id so events can be joined into one analysis attempt without a
 * persistent device or rider identifier.
 */
export function trackAnalysisEvent(
  name: AnalysisEventName,
  analysisId: string,
  parameters: AnalysisEventParameters = {}
): void {
  logMetaAppEvent(name, parameters);
  trackGa4Event(name, `analysis.${analysisId}`, parameters);
}

/** Billing diagnostics go only to GA4, using the existing offline queue. */
export function trackBillingEvent(name: BillingEventName, parameters: AnalysisEventParameters = {}): void {
  trackGa4Event(name, billingSessionId, parameters);
}

function trackGa4Event(name: WorkerAnalyticsEvent["name"], clientId: string, parameters: AnalysisEventParameters): void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return;

  const event: WorkerAnalyticsEvent = {
    clientId,
    eventId: createEventId(),
    name,
    timestampMicros: Date.now() * 1000,
    sessionId: appSessionId,
    platform: Platform.OS,
    appVersion: Constants.expoConfig?.version ?? "unknown",
    parameters: normalizeParameters(parameters)
  };

  void schedule(async () => {
    const queue = await loadQueue();
    queue.push(event);
    await saveQueue(queue);
    await flushQueue(queue);
  }).catch(() => undefined);
}
