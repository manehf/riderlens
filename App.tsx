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
import { Bike, Gauge, ListVideo, Video } from "lucide-react-native";
import { useMemo, useState } from "react";
import { SafeAreaView, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";

import { AppText, BottomTabs, Chip, Screen, type TabItem } from "./src/components/ui";
import { useRiderLensMvp } from "./src/hooks/useRiderLensMvp";
import { GarageScreen } from "./src/screens/GarageScreen";
import { CoachScreen } from "./src/screens/CoachScreen";
import { SessionsScreen } from "./src/screens/SessionsScreen";
import { ToolsScreen } from "./src/screens/ToolsScreen";
import { getSupabaseMode } from "./src/services/supabase";
import { spacing, tokens } from "./src/theme/tokens";

type TabKey = "coach" | "sessions" | "garage" | "tools";

const tabs: TabItem[] = [
  { key: "coach", label: "Coach", icon: Video },
  { key: "sessions", label: "Sessions", icon: ListVideo },
  { key: "garage", label: "Garage", icon: Bike },
  { key: "tools", label: "Tools", icon: Gauge }
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("coach");
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
      case "garage":
        return <GarageScreen store={store} />;
      case "tools":
        return <ToolsScreen store={store} />;
      case "coach":
      default:
        return <CoachScreen store={store} />;
    }
  }, [activeTab, store]);

  if (!sansLoaded || !monoLoaded) {
    return (
      <SafeAreaView style={styles.loadingRoot}>
        <StatusBar style="dark" />
        <View style={styles.loadingMark}>
          <AppText weight="bold" color={tokens.electric}>
            RL
          </AppText>
        </View>
        <AppText weight="bold">Loading RiderLens</AppText>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <Screen>
        <View style={styles.modeBar}>
          <Chip tone={getSupabaseMode() === "configured" ? "green" : "amber"}>
            {getSupabaseMode() === "configured" ? "Supabase connected" : "Demo mode"}
          </Chip>
        </View>
        {currentScreen}
        <BottomTabs items={tabs} activeKey={activeTab} onChange={(key) => setActiveTab(key as TabKey)} />
      </Screen>
    </SafeAreaView>
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
