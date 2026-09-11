import Constants from "expo-constants";
import { Platform } from "react-native";

type MetaSdk = typeof import("react-native-fbsdk-next");
type TrackingTransparency = typeof import("expo-tracking-transparency");

export type MetaAppEventParameters = Record<string, string | number | boolean | undefined>;

const isExpoGo = Constants.executionEnvironment === "storeClient";
let initialization: Promise<void> | undefined;

function loadMetaSdk(): MetaSdk | null {
  if (isExpoGo || (Platform.OS !== "ios" && Platform.OS !== "android")) return null;
  try {
    // The SDK contains native code and is intentionally unavailable in Expo Go.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("react-native-fbsdk-next") as MetaSdk;
  } catch {
    return null;
  }
}

function loadTrackingTransparency(): TrackingTransparency | null {
  if (isExpoGo || Platform.OS !== "ios") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("expo-tracking-transparency") as TrackingTransparency;
  } catch {
    return null;
  }
}

async function initialize(): Promise<void> {
  const meta = loadMetaSdk();
  if (!meta) return;

  try {
    if (Platform.OS === "ios") {
      const tracking = loadTrackingTransparency();
      let trackingGranted = false;
      if (tracking) {
        try {
          let permission = await tracking.getTrackingPermissionsAsync();
          if (permission.status === "undetermined") {
            permission = await tracking.requestTrackingPermissionsAsync();
          }
          trackingGranted = permission.granted;
        } catch {
          trackingGranted = false;
        }
      }

      // Initialize after Apple's prompt. App launches and installs can still be
      // measured without IDFA when permission is declined.
      meta.Settings.initializeSDK();
      meta.Settings.setAutoLogAppEventsEnabled(true);
      meta.Settings.setAdvertiserIDCollectionEnabled(trackingGranted);
      await meta.Settings.setAdvertiserTrackingEnabled(trackingGranted);
    } else {
      meta.Settings.initializeSDK();
      meta.Settings.setAutoLogAppEventsEnabled(true);
      meta.Settings.setAdvertiserIDCollectionEnabled(true);
    }
  } catch {
    // Measurement must never block RiderLens from opening.
  }
}

/** Initialize Meta App Events once per app process. */
export function initializeMetaAppEvents(): Promise<void> {
  initialization ??= initialize();
  return initialization;
}

/**
 * Log a privacy-minimised product event for campaign attribution and funnel
 * diagnostics. Booleans are normalised because the native Meta SDK only
 * accepts string and number parameters. Event logging is deliberately
 * best-effort: analytics must never interrupt the rider's workflow.
 */
export function logMetaAppEvent(eventName: string, parameters: MetaAppEventParameters = {}): void {
  const meta = loadMetaSdk();
  if (!meta) return;

  const normalized = Object.fromEntries(
    Object.entries(parameters).flatMap(([key, value]) => {
      if (value === undefined) return [];
      return [[key, typeof value === "boolean" ? Number(value) : value]];
    })
  ) as Record<string, string | number>;

  void initializeMetaAppEvents()
    .then(() => meta.AppEventsLogger.logEvent(eventName, normalized))
    .catch(() => undefined);
}
