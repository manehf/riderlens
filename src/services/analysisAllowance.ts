import AsyncStorage from "@react-native-async-storage/async-storage";

export const FREE_ANALYSIS_LIMIT = 3;

const STORAGE_KEY = "riderlens:free-analyses-used:v1";

export function normalizeFreeAnalysesUsed(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

export function getFreeAnalysesRemaining(used: number): number {
  return Math.max(0, FREE_ANALYSIS_LIMIT - normalizeFreeAnalysesUsed(used));
}

export async function loadFreeAnalysesUsed(): Promise<number> {
  try {
    return normalizeFreeAnalysesUsed(await AsyncStorage.getItem(STORAGE_KEY));
  } catch {
    return 0;
  }
}

export async function saveFreeAnalysesUsed(used: number): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, String(normalizeFreeAnalysesUsed(used)));
}
