import Constants from "expo-constants";
import { Platform } from "react-native";

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
  } catch {
    return null;
  }
}

function purchasesUi(): PurchasesUiModule | null {
  if (!isRevenueCatAvailable()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("react-native-purchases-ui").default as PurchasesUiModule;
  } catch {
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
  } catch {
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
  } catch {
    return false;
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
export async function presentProPaywall(): Promise<boolean> {
  const ui = purchasesUi();
  if (!ui || !configured) return false;
  try {
    await ui.presentPaywallIfNeeded({ requiredEntitlementIdentifier: PRO_ENTITLEMENT_ID });
    return await isProUser();
  } catch {
    return isProUser();
  }
}

export async function restorePurchases(): Promise<boolean> {
  const sdk = purchases();
  if (!sdk || !configured) return false;
  try {
    return hasProEntitlement(await sdk.restorePurchases());
  } catch {
    return false;
  }
}
