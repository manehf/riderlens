import {
  IBMPlexMono_500Medium,
  IBMPlexMono_700Bold,
  useFonts as useMonoFonts
} from "@expo-google-fonts/ibm-plex-mono";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
  useFonts as useSansFonts
} from "@expo-google-fonts/ibm-plex-sans";
import { ListVideo, Plus, Video } from "lucide-react-native";
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { AppText, BottomTabs, Chip, Screen, type TabItem } from "./src/components/ui";
import { useRiderLensMvp } from "./src/hooks/useRiderLensMvp";
import { CoachScreen } from "./src/screens/CoachScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { getSupabaseMode } from "./src/services/supabase";
import { spacing, tokens } from "./src/theme/tokens";

// MVP focus: capture and the library. The Garage and Tools screens still exist
// in src/screens but are unrouted until the video loop is done.
type TabKey = "coach" | "sessions";

const tabs: TabItem[] = [
  { key: "coach", label: "Capture", icon: Video },
  { key: "sessions", label: "Library", icon: ListVideo }
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("coach");
  // Bumped by the center (+) button: jump to Capture with the camera open.
  const [captureSignal, setCaptureSignal] = useState(0);
  const store = useRiderLensMvp();
  const [sansLoaded] = useSansFonts({
    IBMPlexSans: IBMPlexSans_400Regular,
    "IBMPlexSans-SemiBold": IBMPlexSans_600SemiBold,
    "IBMPlexSans-Bold": IBMPlexSans_700Bold
  });
  const [monoLoaded] = useMonoFonts({
    "IBMPlexMono-Medium": IBMPlexMono_500Medium,
    "IBMPlexMono-Bold": IBMPlexMono_700Bold
  });

  const currentScreen = useMemo(() => {
    switch (activeTab) {
      case "sessions":
        return <SessionsScreen store={store} />;
      case "coach":
      default:
        return <CoachScreen store={store} captureSignal={captureSignal} />;
    }
  }, [activeTab, captureSignal, store]);

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
        <Screen>
          <View style={styles.modeBar}>
            <Chip tone={getSupabaseMode() === "configured" ? "green" : "amber"}>
              {getSupabaseMode() === "configured" ? "Supabase connected" : "Demo mode"}
            </Chip>
          </View>
          {currentScreen}
          <BottomTabs
            items={tabs}
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as TabKey)}
            centerAction={{
              icon: Plus,
              label: "Quick capture",
              onPress: () => {
                setActiveTab("coach");
                setCaptureSignal((value) => value + 1);
              }
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
  modeBar: {
    alignItems: "flex-end",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm
  }
});
