import type { BillingEventName } from "./capture";

export type PaywallContext = {
  paywall_source: "monthly_limit" | "settings";
  allowance_month?: string;
  free_used?: number;
  free_limit?: number;
  free_remaining?: number;
};

type Parameters = Record<string, string | number | boolean | undefined>;
type Dependencies = {
  present: () => Promise<string>;
  readPro: () => Promise<boolean>;
  track: (name: BillingEventName, parameters: Parameters) => void;
  report: (stage: string, error: unknown) => void;
};

/** One native presentation at a time, including taps from different screens.
 * The modal API has no on-present callback. A completed, non-error SDK result
 * confirms presentation retrospectively; a request alone is not an impression.
 */
export function createPaywallPresenter(deps: Dependencies) {
  let active: Promise<boolean> | undefined;
  return (context: PaywallContext = { paywall_source: "settings" }): Promise<boolean> => {
    if (active) return active;
    const parameters = {
      ...context,
      paywall_flow_id: `paywall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    };
    // Start on the next microtask so even a reentrant call shares this promise.
    active = Promise.resolve().then(async () => {
      if (context.paywall_source === "monthly_limit") deps.track("allowance_blocked", parameters);
      deps.track("paywall_requested", parameters);
      let result: string;
      let reported = false;
      try {
        result = await deps.present();
      } catch (error) {
        deps.report("paywall", error);
        reported = true;
        result = "ERROR";
      }
      const knownResult = ["NOT_PRESENTED", "ERROR", "CANCELLED", "PURCHASED", "RESTORED"].includes(result);
      if (!reported && (!knownResult || result === "ERROR")) deps.report("paywall_result", { code: "sdk_error_result" });
      const pro = await deps.readPro();
      deps.track("paywall_result", {
        ...parameters,
        paywall_result: knownResult ? result.toLowerCase() : "unknown",
        presentation_confirmed: ["CANCELLED", "PURCHASED", "RESTORED"].includes(result),
        has_pro: pro
      });
      return pro;
    }).finally(() => { active = undefined; });
    return active;
  };
}

/** Whitelist only the SDK's short code; never send error messages, receipts,
 * store account details, or customer identifiers to analytics. */
export function billingErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return (typeof code === "number" || typeof code === "string") && /^[a-zA-Z0-9_-]{1,60}$/.test(String(code))
    ? String(code) : "unknown";
}
