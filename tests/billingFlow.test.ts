import { describe, expect, it, vi } from "vitest";
import { billingErrorCode, createPaywallPresenter } from "../src/services/billingFlow";

function harness(result: string, pro = false) {
  const deps = { present: vi.fn(async () => result), readPro: vi.fn(async () => pro), track: vi.fn(), report: vi.fn() };
  return { ...deps, open: createPaywallPresenter(deps) };
}

describe("paywall measurement", () => {
  it.each([
    ["NOT_PRESENTED", false], ["ERROR", false], ["CANCELLED", true],
    ["PURCHASED", true], ["RESTORED", true], ["unexpected", false]
  ])("distinguishes %s from a confirmed presentation", async (result, confirmed) => {
    const flow = harness(result as string);
    await flow.open();
    expect(flow.track).toHaveBeenNthCalledWith(1, "paywall_requested", expect.objectContaining({ paywall_source: "settings" }));
    expect(flow.track).toHaveBeenLastCalledWith("paywall_result", expect.objectContaining({
      presentation_confirmed: confirmed, has_pro: false
    }));
    expect(flow.report).toHaveBeenCalledTimes(result === "ERROR" || result === "unexpected" ? 1 : 0);
  });

  it("joins quota blocking to the paywall result and verifies entitlement after purchase", async () => {
    const flow = harness("PURCHASED", true);
    expect(await flow.open({ paywall_source: "monthly_limit", free_remaining: 0, free_limit: 3 })).toBe(true);
    expect(flow.track.mock.calls.map(([name]) => name)).toEqual(["allowance_blocked", "paywall_requested", "paywall_result"]);
    const contexts = flow.track.mock.calls.map(([, params]) => params);
    expect(new Set(contexts.map((context) => context.paywall_flow_id)).size).toBe(1);
    expect(contexts[2]).toMatchObject({ paywall_result: "purchased", has_pro: true, free_remaining: 0 });
  });

  it("does not infer Pro just because restore returned a result", async () => {
    expect(await harness("RESTORED", false).open()).toBe(false);
  });

  it("deduplicates concurrent taps but permits a later independent attempt", async () => {
    let complete!: (value: string) => void;
    const deps = {
      present: vi.fn(() => new Promise<string>((resolve) => { complete = resolve; })),
      readPro: vi.fn(async () => false), track: vi.fn(), report: vi.fn()
    };
    const open = createPaywallPresenter(deps);
    const first = open({ paywall_source: "monthly_limit" });
    const duplicate = open();
    expect(first).toBe(duplicate);
    await Promise.resolve();
    expect(deps.present).toHaveBeenCalledTimes(1);
    complete("CANCELLED");
    await first;
    const next = open();
    await Promise.resolve();
    complete("NOT_PRESENTED");
    await next;
    expect(deps.present).toHaveBeenCalledTimes(2);
  });

  it("records a rejected presentation once and does not fabricate an impression", async () => {
    const flow = harness("CANCELLED");
    flow.present.mockRejectedValueOnce({ code: 23, message: "sensitive store message" });
    expect(await flow.open()).toBe(false);
    expect(flow.report).toHaveBeenCalledTimes(1);
    expect(flow.track).toHaveBeenLastCalledWith("paywall_result", expect.objectContaining({
      paywall_result: "error", presentation_confirmed: false
    }));
    expect(JSON.stringify(flow.track.mock.calls)).not.toContain("sensitive");
  });

  it("only exports bounded diagnostic codes", () => {
    expect(billingErrorCode({ code: 23, message: "receipt" })).toBe("23");
    expect(billingErrorCode(new Error("account details"))).toBe("unknown");
    expect(billingErrorCode({ code: "rider@example.com" })).toBe("unknown");
    expect(billingErrorCode({ code: "x".repeat(100) })).toBe("unknown");
  });
});
