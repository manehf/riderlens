import { ArrowUpCircle } from "lucide-react-native";
import { useState } from "react";
import { Alert, Linking, Modal, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText, Button, Card, Heading, NumberText } from "./ui";
import type { AppUpdateNotice } from "../services/appVersion";
import { radius, spacing, tokens } from "../theme/tokens";

type AppUpdatePromptProps = {
  notice?: AppUpdateNotice;
  onDismiss: () => void;
};

export function AppUpdatePrompt({ notice, onDismiss }: AppUpdatePromptProps) {
  const [openingStore, setOpeningStore] = useState(false);
  if (!notice) return null;
  const { required, storeUrl } = notice;

  async function openStore() {
    setOpeningStore(true);
    try {
      await Linking.openURL(storeUrl);
      if (!required) onDismiss();
    } catch {
      Alert.alert("Could not open the store", "Open the App Store or Google Play and search for RiderLens.");
    } finally {
      setOpeningStore(false);
    }
  }

  return (
    <Modal
      animationType="fade"
      navigationBarTranslucent
      onRequestClose={notice.required ? () => undefined : onDismiss}
      statusBarTranslucent
      transparent
      visible
    >
      <SafeAreaView style={styles.overlay}>
        <View accessibilityViewIsModal style={styles.modalWrap}>
          <Card style={styles.modal}>
            <View style={styles.icon}>
              <ArrowUpCircle color={tokens.graphite} size={26} strokeWidth={2.4} />
            </View>
            <View style={styles.copy}>
              <AppText color={tokens.green} size={12} weight="bold" style={styles.eyebrow}>
                {notice.required ? "UPDATE REQUIRED" : "UPDATE AVAILABLE"}
              </AppText>
              <Heading level={2}>Update RiderLens</Heading>
              <AppText color={tokens.textMuted} size={14} style={styles.body}>
                {notice.required
                  ? "This version is no longer supported. Update RiderLens to continue."
                  : notice.message}
              </AppText>
              <NumberText color={tokens.textMuted} size={12}>
                {notice.currentVersion} → {notice.latestVersion}
              </NumberText>
            </View>
            <View style={styles.actions}>
              {!notice.required ? (
                <Button disabled={openingStore} onPress={onDismiss} variant="secondary" style={styles.action}>
                  Later
                </Button>
              ) : null}
              <Button disabled={openingStore} onPress={() => void openStore()} style={styles.action}>
                {openingStore ? "Opening..." : "Update"}
              </Button>
            </View>
          </Card>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: "rgba(17, 22, 19, 0.72)"
  },
  modalWrap: {
    width: "100%",
    maxWidth: 420,
    alignSelf: "center"
  },
  modal: {
    gap: spacing.lg,
    padding: spacing.xl
  },
  icon: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: tokens.electric
  },
  copy: {
    gap: spacing.sm
  },
  eyebrow: {
    letterSpacing: 0
  },
  body: {
    lineHeight: 20
  },
  actions: {
    flexDirection: "row",
    gap: spacing.sm
  },
  action: {
    flex: 1
  }
});
