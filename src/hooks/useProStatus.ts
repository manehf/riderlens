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
  const [ready, setReady] = useState(!available);

  const refresh = useCallback(async () => {
    if (!available) {
      setReady(true);
      return false;
    }
    configureRevenueCat();
    const pro = await isProUser();
    setIsPro(pro);
    setReady(true);
    return pro;
  }, [available]);

  useEffect(() => {
    if (!available) {
      setReady(true);
      return;
    }
    configureRevenueCat();
    let active = true;
    void isProUser()
      .then((pro) => {
        if (active) setIsPro(pro);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    const unsubscribe = onProStatusChange((pro) => {
      if (active) {
        setIsPro(pro);
        setReady(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [available]);

  const upgrade = useCallback(async () => {
    configureRevenueCat();
    const pro = await presentProPaywall();
    setIsPro(pro);
    setReady(true);
    return pro;
  }, []);

  const restore = useCallback(async () => {
    configureRevenueCat();
    const pro = await restorePurchases();
    setIsPro(pro);
    setReady(true);
    return pro;
  }, []);

  return { available, ready, isPro, refresh, upgrade, restore };
}
