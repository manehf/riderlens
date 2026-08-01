import AsyncStorage from "@react-native-async-storage/async-storage";

import { getWorkerUrlCandidates } from "./analysisWorker";
import {
  compareAppVersions,
  evaluateAppUpdate,
  parseAppVersionConfig,
  type AppUpdateNotice,
  type AppVersionConfig,
  type MobilePlatform
} from "./appVersion";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const STORAGE_KEY_PREFIX = "riderlens:app-update:v1";

type PersistedUpdateState = {
  lastCheckedAt?: number;
  latestVersion?: string;
  minimumSupportedVersion?: string;
  dismissedVersion?: string;
};

function storageKey(platform: MobilePlatform): string {
  return `${STORAGE_KEY_PREFIX}:${platform}`;
}

async function loadState(platform: MobilePlatform): Promise<PersistedUpdateState> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(platform));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PersistedUpdateState) : {};
  } catch {
    return {};
  }
}

async function saveState(platform: MobilePlatform, state: PersistedUpdateState): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(platform), JSON.stringify(state));
  } catch {
    // Update checks must never interfere with the analysis workflow.
  }
}

async function fetchVersionConfig(platform: MobilePlatform): Promise<AppVersionConfig | undefined> {
  for (const workerUrl of getWorkerUrlCandidates()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${workerUrl}/app/version?platform=${platform}`, {
        method: "GET",
        signal: controller.signal
      });
      if (!response.ok) continue;
      const config = parseAppVersionConfig(await response.json(), platform);
      if (config) return config;
    } catch {
      // Try the next candidate; no reachable worker means no update prompt.
    } finally {
      clearTimeout(timeout);
    }
  }
  return undefined;
}

export async function checkForAppUpdate(
  platform: MobilePlatform,
  currentVersion: string,
  now = Date.now()
): Promise<AppUpdateNotice | undefined> {
  const state = await loadState(platform);
  const knownRequired =
    typeof state.minimumSupportedVersion === "string" &&
    compareAppVersions(currentVersion, state.minimumSupportedVersion) < 0;
  const recentlyChecked =
    typeof state.lastCheckedAt === "number" && now - state.lastCheckedAt < CHECK_INTERVAL_MS;

  // A known unsupported build rechecks on every foreground. If the worker is
  // unavailable the check fails open, which keeps offline riding usable.
  if (!knownRequired && recentlyChecked) return undefined;

  const config = await fetchVersionConfig(platform);
  if (!config) return undefined;

  await saveState(platform, {
    ...state,
    lastCheckedAt: now,
    latestVersion: config.latestVersion,
    minimumSupportedVersion: config.minimumSupportedVersion
  });

  const notice = evaluateAppUpdate(currentVersion, config);
  if (!notice) return undefined;
  if (!notice.required && state.dismissedVersion === notice.latestVersion) return undefined;
  return notice;
}

export async function dismissAppUpdate(
  platform: MobilePlatform,
  latestVersion: string
): Promise<void> {
  const state = await loadState(platform);
  await saveState(platform, { ...state, dismissedVersion: latestVersion });
}
