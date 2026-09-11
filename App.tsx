import {
  IBMPlexMono_500Medium,
  IBMPlexMono_700Bold,
  useFonts as useMonoFonts
} from "@expo-google-fonts/ibm-plex-mono";
import { BebasNeue_400Regular } from "@expo-google-fonts/bebas-neue";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
  useFonts as useSansFonts
} from "@expo-google-fonts/ibm-plex-sans";
import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import { Plus } from "lucide-react-native";
import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { AppUpdatePrompt } from "./src/components/AppUpdatePrompt";
import { AppText, Screen } from "./src/components/ui";
import { useRiderLensMvp } from "./src/hooks/useRiderLensMvp";
import { checkForAppUpdate, dismissAppUpdate } from "./src/services/appUpdate";
import type { AppUpdateNotice, MobilePlatform } from "./src/services/appVersion";
import { isAnalysisWorkerReachable } from "./src/services/capture";
import { initializeProductAnalytics } from "./src/services/productAnalytics";
import { CaptureSheet } from "./src/screens/CaptureSheet";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { radius, shadows, spacing, tokens } from "./src/theme/tokens";

// Crash visibility: testers' crashes are invisible without this. DSN-gated so
// Expo Go / keyless dev sessions run without Sentry. No PII, no media — stack
// traces and device model only (the privacy page discloses exactly this).
const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 50
  });
}

// One home (the library), one action (capture). The Garage and Tools screens
// still exist in src/screens but are unrouted until the video loop is done.
function App() {
  const [captureOpen, setCaptureOpen] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateNotice>();

  // The app lives in portrait; fullscreen video unlocks rotation temporarily.
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    void initializeProductAnalytics();
  }, []);
  // "camera" = jump straight into recording when the sheet opens.
  const [captureIntent, setCaptureIntent] = useState<"camera" | undefined>();
  const store = useRiderLensMvp();

  useEffect(() => {
    const resolvedPlatform =
      Platform.OS === "ios" || Platform.OS === "android" ? (Platform.OS as MobilePlatform) : undefined;
    const resolvedVersion = Constants.expoConfig?.version;
    if (!resolvedPlatform || !resolvedVersion) return;
    const platform: MobilePlatform = resolvedPlatform;
    const currentVersion: string = resolvedVersion;

    let active = true;
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const notice = await checkForAppUpdate(platform, currentVersion);
        if (active && notice) setAppUpdate(notice);
      } finally {
        checking = false;
      }
    }

    void check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  function dismissUpdatePrompt() {
    if (!appUpdate || appUpdate.required) return;
    setAppUpdate(undefined);
    void dismissAppUpdate(appUpdate.platform, appUpdate.latestVersion);
  }

  // (+) goes straight to the photo picker. Filming happens in the phone's own
  // camera app so the original always stays safe in Photos/Gallery — an
  // in-app camera would trap footage inside RiderLens (delete record = lose it).
  function onCapturePress() {
    // Prewarm: a scale-to-zero worker takes ~14s to cold start — pinging now
    // means it's awake by the time the rider has picked a clip.
    void isAnalysisWorkerReachable();
    void store.uploadVideoFromLibrary();
  }

  // Picking from the library happens over the home screen; once a clip is
  // chosen the pending capture appears and the sheet opens on the trim step.
  useEffect(() => {
    if (store.pendingCapture && !captureOpen) {
      setCaptureOpen(true);
    }
  }, [store.pendingCapture, captureOpen]);
  const [sansLoaded] = useSansFonts({
    IBMPlexSans: IBMPlexSans_400Regular,
    "IBMPlexSans-SemiBold": IBMPlexSans_600SemiBold,
    "IBMPlexSans-Bold": IBMPlexSans_700Bold,
    BebasNeue: BebasNeue_400Regular
  });
  const [monoLoaded] = useMonoFonts({
    "IBMPlexMono-Medium": IBMPlexMono_500Medium,
    "IBMPlexMono-Bold": IBMPlexMono_700Bold
  });

  if (!sansLoaded || !monoLoaded) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.loadingRoot}>
          <StatusBar style="dark" />
          <View style={styles.loadingMark}>
            <AppText weight="bold" color={tokens.electric}>
              RL
            </AppText>
          </View>
          <AppText weight="bold">Loading RiderLens</AppText>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <Screen insetBottom={0}>
          <SessionsScreen store={store} />
          <View style={styles.fabWrap} pointerEvents="box-none">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Capture a moment"
              onPress={onCapturePress}
              style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
            >
              <Plus color={tokens.graphite} size={28} strokeWidth={2.6} />
            </Pressable>
          </View>
          <CaptureSheet store={store} visible={captureOpen} onClose={() => setCaptureOpen(false)} />
          <AppUpdatePrompt notice={appUpdate} onDismiss={dismissUpdatePrompt} />
        </Screen>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: tokens.background
  },
  loadingRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    backgroundColor: tokens.background
  },
  loadingMark: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: tokens.graphite
  },
  fabWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    // SafeAreaView already clears the home indicator; this keeps the button
    // from crowding it visually.
    bottom: spacing.xl + 8,
    alignItems: "center"
  },
  fab: {
    width: 62,
    height: 62,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: tokens.electric,
    ...shadows.card
  },
  fabPressed: {
    transform: [{ scale: 0.95 }]
  }
});

export default sentryDsn ? Sentry.wrap(App) : App;
