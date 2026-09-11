import Constants from "expo-constants";
import { Platform } from "react-native";
import * as Sentry from "@sentry/react-native";
import { billingErrorCode, createPaywallPresenter, type PaywallContext } from "./billingFlow";
import { trackBillingEvent } from "./productAnalytics";

export type { PaywallContext } from "./billingFlow";

function reportBillingError(stage: string, error: unknown): void {
  const code = billingErrorCode(error);
  trackBillingEvent("billing_error", { billing_stage: stage, billing_error_code: code });
  Sentry.captureMessage(`Billing operation failed: ${stage}`, {
    level: "warning", tags: { workflow: "billing", billing_stage: stage, billing_error_code: code }
  });
}

// RevenueCat is available only in a native build with a platform public SDK
// key. Expo Go cannot load the native purchases module.

export const PRO_ENTITLEMENT_ID = process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID || "RiderLens Pro";

const isExpoGo = Constants.executionEnvironment === "storeClient";

export function getRevenueCatApiKey(): string | null {
  if (Platform.OS === "ios") {
    return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY || null;
  }
  if (Platform.OS === "android") {
    return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY || null;
  }
  return null;
}

export function isRevenueCatAvailable(): boolean {
  return !isExpoGo && Boolean(getRevenueCatApiKey());
}

type PurchasesModule = typeof import("react-native-purchases").default;
type PurchasesUiModule = typeof import("react-native-purchases-ui").default;
type CustomerInfo = import("react-native-purchases").CustomerInfo;

/** Lazy require: the native module does not exist inside Expo Go. */
function purchases(): PurchasesModule | null {
  if (!isRevenueCatAvailable()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("react-native-purchases").default as PurchasesModule;
  } catch (error) {
    reportBillingError("load_purchases", error);
    return null;
  }
}

function purchasesUi(): PurchasesUiModule | null {
  if (!isRevenueCatAvailable()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("react-native-purchases-ui").default as PurchasesUiModule;
  } catch (error) {
    reportBillingError("load_paywall", error);
    return null;
  }
}

let configured = false;

export function configureRevenueCat(): void {
  const sdk = purchases();
  const apiKey = getRevenueCatApiKey();
  if (!sdk || !apiKey || configured) return;
  try {
    sdk.configure({ apiKey });
    configured = true;
  } catch (error) {
    reportBillingError("configure", error);
    // Never let billing plumbing break the app.
  }
}

function hasProEntitlement(customerInfo: CustomerInfo): boolean {
  return Boolean(customerInfo.entitlements.active[PRO_ENTITLEMENT_ID]);
}

export async function isProUser(): Promise<boolean> {
  const sdk = purchases();
  if (!sdk || !configured) return false;
  try {
    return hasProEntitlement(await sdk.getCustomerInfo());
  } catch (error) {
    reportBillingError("customer_info", error);
    return false;
  }
}

/** Return the identifier shown for this installation in RevenueCat. This is
 * intentionally read-only; a future authenticated account can replace it via
 * Purchases.logIn without changing the Settings UI. */
export async function getRevenueCatAppUserId(): Promise<string | null> {
  configureRevenueCat();
  const sdk = purchases();
  if (!sdk || !configured) return null;
  try {
    return await sdk.getAppUserID();
  } catch {
    return null;
  }
}

/** Subscribe to entitlement changes. Returns an unsubscribe fn. */
export function onProStatusChange(listener: (isPro: boolean) => void): () => void {
  const sdk = purchases();
  if (!sdk || !configured) return () => undefined;
  const wrapped = (customerInfo: CustomerInfo) => listener(hasProEntitlement(customerInfo));
  sdk.addCustomerInfoUpdateListener(wrapped);
  return () => {
    try {
      sdk.removeCustomerInfoUpdateListener(wrapped);
    } catch {
      // SDK teardown races are harmless here.
    }
  };
}

/** Present the RevenueCat paywall unless already entitled. Resolves to the
 * resulting Pro status. */
const presentPaywall = createPaywallPresenter({
  present: async () => {
    const ui = purchasesUi();
    if (!ui || !configured) throw { code: "billing_unavailable" };
    return ui.presentPaywallIfNeeded({ requiredEntitlementIdentifier: PRO_ENTITLEMENT_ID });
  },
  readPro: isProUser,
  track: trackBillingEvent,
  report: reportBillingError
});

export function presentProPaywall(context?: PaywallContext): Promise<boolean> {
  return presentPaywall(context);
}

export async function restorePurchases(): Promise<boolean> {
  const sdk = purchases();
  if (!sdk || !configured) {
    trackBillingEvent("restore_result", { paywall_result: "unavailable", has_pro: false });
    return false;
  }
  try {
    const pro = hasProEntitlement(await sdk.restorePurchases());
    trackBillingEvent("restore_result", { paywall_result: "completed", has_pro: pro });
    return pro;
  } catch (error) {
    reportBillingError("restore", error);
    trackBillingEvent("restore_result", { paywall_result: "error", has_pro: false });
    return false;
  }
}
