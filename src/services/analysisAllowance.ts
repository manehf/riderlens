import AsyncStorage from "@react-native-async-storage/async-storage";

export const FREE_ANALYSIS_LIMIT = 3;

// v2 scopes usage to a calendar month (device-local): the free tier renews —
// "3 per month", never a lifetime cap, so the archive habit keeps building.
// v1 stored a bare lifetime integer; it is deliberately ignored so existing
// riders start the migration month with a fresh allowance.
const STORAGE_KEY = "riderlens:free-analyses:v2";
const LEGACY_STORAGE_KEY = "riderlens:free-analyses-used:v1";

export type FreeAllowance = {
  /** Device-local calendar month the counter belongs to, e.g. "2026-07". */
  month: string;
  used: number;
};

/** Month key in the rider's local timezone — resets happen at their midnight,
 * not UTC's. */
export function currentAllowanceMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function normalizeFreeAnalysesUsed(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

/** Usage counting against the current month. A counter from an earlier month
 * is spent history, not spendable allowance — it reads as zero. */
export function usedThisMonth(allowance: FreeAllowance | undefined, now: Date = new Date()): number {
  if (!allowance || allowance.month !== currentAllowanceMonth(now)) return 0;
  return normalizeFreeAnalysesUsed(allowance.used);
}

export function getFreeAnalysesRemaining(allowance: FreeAllowance | undefined, now: Date = new Date()): number {
  return Math.max(0, FREE_ANALYSIS_LIMIT - usedThisMonth(allowance, now));
}

/** The allowance after spending one analysis now. Crossing a month boundary
 * mid-session starts the new month's count at 1 rather than carrying the old
 * month's spend. */
export function consumeFreeAnalysis(allowance: FreeAllowance | undefined, now: Date = new Date()): FreeAllowance {
  return { month: currentAllowanceMonth(now), used: usedThisMonth(allowance, now) + 1 };
}

export async function loadFreeAllowance(): Promise<FreeAllowance | undefined> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<FreeAllowance> | null;
    if (!parsed || typeof parsed.month !== "string") return undefined;
    return { month: parsed.month, used: normalizeFreeAnalysesUsed(parsed.used) };
  } catch {
    return undefined;
  }
}

export async function saveFreeAllowance(allowance: FreeAllowance): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(allowance));
  // One-time hygiene; the v1 lifetime counter is never read again.
  AsyncStorage.removeItem(LEGACY_STORAGE_KEY).catch(() => undefined);
}
