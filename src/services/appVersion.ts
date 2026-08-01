export type MobilePlatform = "ios" | "android";

export type AppVersionConfig = {
  platform: MobilePlatform;
  latestVersion: string;
  minimumSupportedVersion: string;
  storeUrl: string;
  message: string;
};

export type AppUpdateNotice = AppVersionConfig & {
  currentVersion: string;
  required: boolean;
};

function parseVersion(version: string): number[] | undefined {
  const core = version.trim().split(/[+-]/, 1)[0];
  if (!/^\d+(?:\.\d+){0,3}$/.test(core)) return undefined;
  return core.split(".").map(Number);
}

/** Numeric version comparison: 1.0.10 correctly sorts after 1.0.9. */
export function compareAppVersions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

export function parseAppVersionConfig(
  payload: unknown,
  expectedPlatform: MobilePlatform
): AppVersionConfig | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = payload as Partial<AppVersionConfig>;
  const latestVersion = candidate.latestVersion;
  const minimumSupportedVersion = candidate.minimumSupportedVersion;
  if (
    candidate.platform !== expectedPlatform ||
    typeof latestVersion !== "string" ||
    typeof minimumSupportedVersion !== "string" ||
    typeof candidate.storeUrl !== "string" ||
    typeof candidate.message !== "string" ||
    !parseVersion(latestVersion) ||
    !parseVersion(minimumSupportedVersion) ||
    !/^https:\/\//.test(candidate.storeUrl) ||
    compareAppVersions(minimumSupportedVersion, latestVersion) > 0
  ) {
    return undefined;
  }
  return candidate as AppVersionConfig;
}

export function evaluateAppUpdate(
  currentVersion: string,
  config: AppVersionConfig
): AppUpdateNotice | undefined {
  if (!parseVersion(currentVersion)) return undefined;
  const belowMinimum = compareAppVersions(currentVersion, config.minimumSupportedVersion) < 0;
  const belowLatest = compareAppVersions(currentVersion, config.latestVersion) < 0;
  if (!belowMinimum && !belowLatest) return undefined;
  return { ...config, currentVersion, required: belowMinimum };
}
