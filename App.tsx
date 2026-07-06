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
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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
  const store = useRiderLensMvp();
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
              onPress={() => setCaptureOpen(true)}
              style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
            >
              <Plus color={tokens.graphite} size={28} strokeWidth={2.6} />
            </Pressable>
          </View>
          <CaptureSheet store={store} visible={captureOpen} onClose={() => setCaptureOpen(false)} />
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
