import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(), send: vi.fn(), meta: vi.fn()
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => mocks.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.storage.set(key, value); },
  removeItem: async (key: string) => { mocks.storage.delete(key); }
} }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("../src/services/metaAppEvents", () => ({
  initializeMetaAppEvents: async () => undefined, logMetaAppEvent: mocks.meta
}));
vi.mock("../src/services/capture", () => ({ sendAnalyticsEventToWorker: mocks.send }));

beforeEach(() => {
  vi.resetModules();
  mocks.storage.clear();
  mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.meta.mockReset();
});

describe("billing analytics delivery", () => {
  it("queues offline and replays the same event identity and occurrence time", async () => {
    const analytics = await import("../src/services/productAnalytics");
    mocks.send.mockRejectedValue(new Error("offline"));
    analytics.trackBillingEvent("paywall_requested", { paywall_source: "monthly_limit" });
    await analytics.initializeProductAnalytics();
    const original = mocks.send.mock.calls[0][0];
    expect(original.clientId).toMatch(/^billing\./);
    expect(mocks.storage.size).toBe(1);
    mocks.send.mockResolvedValue(undefined);
    await analytics.initializeProductAnalytics();
    expect(mocks.send.mock.lastCall?.[0]).toEqual(original);
    expect(mocks.storage.size).toBe(0);
    expect(mocks.meta).not.toHaveBeenCalled();
  });

  it("joins a billing session and preserves existing analysis attribution", async () => {
    const analytics = await import("../src/services/productAnalytics");
    analytics.trackBillingEvent("allowance_exhausted", { free_remaining: 0 });
    analytics.trackBillingEvent("paywall_result", { paywall_result: "cancelled", has_pro: false });
    analytics.trackAnalysisEvent("analysis_completed", "record-12345678");
    await analytics.initializeProductAnalytics();
    const events = mocks.send.mock.calls.map(([event]) => event);
    expect(events).toHaveLength(3);
    expect(events[0].clientId).toEqual(events[1].clientId);
    expect(events[2].clientId).toBe("analysis.record-12345678");
    expect(events[1].parameters.has_pro).toBe(false);
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    expect(mocks.meta).toHaveBeenCalledTimes(1);
  });
});
