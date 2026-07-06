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
import { Plus } from "lucide-react-native";
import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { AppText, Screen } from "./src/components/ui";
import { useRiderLensMvp } from "./src/hooks/useRiderLensMvp";
import { CaptureSheet } from "./src/screens/CaptureSheet";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { radius, shadows, spacing, tokens } from "./src/theme/tokens";

// One home (the library), one action (capture). The Garage and Tools screens
// still exist in src/screens but are unrouted until the video loop is done.
export default function App() {
  const [captureOpen, setCaptureOpen] = useState(false);

  // The app lives in portrait; fullscreen video unlocks rotation temporarily.
  useEffect(() => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, []);
  // "camera" = jump straight into recording when the sheet opens.
  const [captureIntent, setCaptureIntent] = useState<"camera" | undefined>();
  const store = useRiderLensMvp();

  // (+) shows the native action sheet; the capture sheet only appears when
  // there is real content to show (the camera, or the trim step after picking).
  function onCapturePress() {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Record video", "Pick from library", "Cancel"], cancelButtonIndex: 2 },
        (index) => {
          if (index === 0) {
            setCaptureIntent("camera");
            setCaptureOpen(true);
          } else if (index === 1) {
            void store.uploadVideoFromLibrary();
          }
        }
      );
    } else {
      // Android: native dialog with the same three choices.
      Alert.alert("Capture a moment", undefined, [
        {
          text: "Record video",
          onPress: () => {
            setCaptureIntent("camera");
            setCaptureOpen(true);
          }
        },
        { text: "Pick from library", onPress: () => void store.uploadVideoFromLibrary() },
        { text: "Cancel", style: "cancel" }
      ]);
    }
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
          <CaptureSheet
            store={store}
            visible={captureOpen}
            intent={captureIntent}
            onClose={() => {
              setCaptureOpen(false);
              setCaptureIntent(undefined);
            }}
          />
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
    bottom: spacing.xl,
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
