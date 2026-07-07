import { useCallback, useEffect, useState } from "react";

import {
  configureRevenueCat,
  isProUser,
  isRevenueCatAvailable,
  onProStatusChange,
  presentProPaywall,
  restorePurchases
} from "../services/revenueCat";

/** Pro entitlement state. `available` is false in Expo Go or without API keys —
 * callers hide their billing UI entirely in that case. */
export function useProStatus() {
  const available = isRevenueCatAvailable();
  const [isPro, setIsPro] = useState(false);

  useEffect(() => {
    if (!available) return;
    configureRevenueCat();
    let active = true;
    void isProUser().then((pro) => {
      if (active) setIsPro(pro);
    });
    const unsubscribe = onProStatusChange((pro) => {
      if (active) setIsPro(pro);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [available]);

  const upgrade = useCallback(async () => {
    setIsPro(await presentProPaywall());
  }, []);

  const restore = useCallback(async () => {
    const pro = await restorePurchases();
    setIsPro(pro);
    return pro;
  }, []);

  return { available, isPro, upgrade, restore };
}
