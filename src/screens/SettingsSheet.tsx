import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { Bike, Ruler, User, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { AppText, Card, DisplayText, NumberText } from "../components/ui";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { radius, spacing, tokens } from "../theme/tokens";
import type { UnitSystem } from "../types/domain";

type SettingsSheetProps = {
  store: RiderLensStore;
  visible: boolean;
  onClose: () => void;
};

const CM_PER_INCH = 2.54;
const KG_PER_LB = 0.45359237;

type MeasureKind = "length" | "mass";

/** Values are stored canonically in metric; imperial is a display lens. */
function toDisplay(canonical: number | undefined, kind: MeasureKind, units: UnitSystem): number | undefined {
  if (canonical === undefined) return undefined;
  if (units === "metric") return canonical;
  return kind === "length" ? canonical / CM_PER_INCH : canonical / KG_PER_LB;
}

function toCanonical(display: number, kind: MeasureKind, units: UnitSystem): number {
  if (units === "metric") return display;
  return kind === "length" ? display * CM_PER_INCH : display * KG_PER_LB;
}

function unitLabel(kind: MeasureKind, units: UnitSystem): string {
  if (kind === "length") return units === "metric" ? "cm" : "in";
  return units === "metric" ? "kg" : "lbs";
}

/** Copy the picked image into app storage (picker cache gets purged). A fresh
 * filename busts the Image cache; the previous avatar file is removed. */
async function pickAvatar(previousUri?: string): Promise<string | undefined> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert("Photo access needed", "Allow photo access to choose a profile image.");
    return undefined;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8
  });
  if (result.canceled) return undefined;
  const asset = result.assets[0];

  const directory = `${FileSystem.documentDirectory}riderlens/profile/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const target = `${directory}avatar-${Date.now().toString(36)}.jpg`;
  await FileSystem.copyAsync({ from: asset.uri, to: target });
  if (previousUri) {
    FileSystem.deleteAsync(previousUri, { idempotent: true }).catch(() => undefined);
  }
  return target;
}

export function SettingsSheet({ store, visible, onClose }: SettingsSheetProps) {
  const { profile } = store;
  const version = Constants.expoConfig?.version ?? "dev";
  const [nameDraft, setNameDraft] = useState(profile.name ?? "");

  useEffect(() => {
    setNameDraft(profile.name ?? "");
  }, [profile.name]);

  async function changeAvatar() {
    const avatarUri = await pickAvatar(profile.avatarUri);
    if (avatarUri) store.saveProfile({ avatarUri });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <View style={styles.sheetHeader}>
          <DisplayText size={24}>SETTINGS</DisplayText>
          <Pressable accessibilityRole="button" accessibilityLabel="Close settings" onPress={onClose} style={styles.sheetClose}>
            <X color={tokens.text} size={20} strokeWidth={2.4} />
          </Pressable>
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.keyboardArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Card style={styles.section}>
            <View style={styles.sectionHeader}>
              <User color={tokens.green} size={16} strokeWidth={2.4} />
              <AppText weight="bold">Rider</AppText>
            </View>

            <View style={styles.riderRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="Change profile image" onPress={changeAvatar}>
                {profile.avatarUri ? (
                  <Image source={{ uri: profile.avatarUri }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarPlaceholder]}>
                    <User color={tokens.textMuted} size={26} strokeWidth={2} />
                  </View>
                )}
              </Pressable>
              <View style={styles.riderFields}>
                <TextInput
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  onEndEditing={() => store.saveProfile({ name: nameDraft.trim() || undefined })}
                  placeholder="Your name"
                  placeholderTextColor={tokens.textMuted}
                  autoCapitalize="words"
                  style={styles.nameInput}
                />
                <AppText color={tokens.textMuted} size={11}>
                  Tap the photo to change it.
                </AppText>
              </View>
            </View>

            <View style={styles.fieldRow}>
              <AppText weight="semi" size={13} style={styles.fieldLabel}>
                Lead foot
              </AppText>
              <View style={styles.segmented}>
                <SegmentButton
                  label="Left"
                  active={profile.leadFoot === "left"}
                  onPress={() => store.saveProfile({ leadFoot: "left" })}
                />
                <SegmentButton
                  label="Right"
                  active={profile.leadFoot === "right"}
                  onPress={() => store.saveProfile({ leadFoot: "right" })}
                />
              </View>
            </View>
          </Card>

          <Card style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ruler color={tokens.green} size={16} strokeWidth={2.4} />
              <AppText weight="bold">Body</AppText>
            </View>
            <AppText color={tokens.textMuted} size={12} style={styles.sectionNote}>
              Your dimensions power upcoming features — bike fit and jump metrics calibrated to your body. Optional, stored
              only on this phone.
            </AppText>

            <View style={styles.fieldRow}>
              <AppText weight="semi" size={13} style={styles.fieldLabel}>
                Units
              </AppText>
              <View style={styles.segmented}>
                <SegmentButton
                  label="Imperial"
                  active={profile.units === "imperial"}
                  onPress={() => store.saveProfile({ units: "imperial" })}
                />
                <SegmentButton
                  label="Metric"
                  active={profile.units === "metric"}
                  onPress={() => store.saveProfile({ units: "metric" })}
                />
              </View>
            </View>

            <MeasurementField
              label="Height"
              kind="length"
              units={profile.units}
              canonical={profile.heightCm}
              onCommit={(heightCm) => store.saveProfile({ heightCm })}
            />
            <MeasurementField
              label="Weight"
              kind="mass"
              units={profile.units}
              canonical={profile.weightKg}
              onCommit={(weightKg) => store.saveProfile({ weightKg })}
            />
            <MeasurementField
              label="Inseam"
              kind="length"
              units={profile.units}
              canonical={profile.inseamCm}
              onCommit={(inseamCm) => store.saveProfile({ inseamCm })}
            />
            <MeasurementField
              label="Arm length"
              kind="length"
              units={profile.units}
              canonical={profile.armLengthCm}
              onCommit={(armLengthCm) => store.saveProfile({ armLengthCm })}
            />
            <MeasurementField
              label="Arm span"
              kind="length"
              units={profile.units}
              canonical={profile.armSpanCm}
              onCommit={(armSpanCm) => store.saveProfile({ armSpanCm })}
            />
          </Card>

          <Card style={styles.section}>
            <View style={styles.sectionHeader}>
              <Bike color={tokens.green} size={16} strokeWidth={2.4} />
              <AppText weight="bold">Bike fit</AppText>
            </View>
            <AppText color={tokens.textMuted} size={12} style={styles.sectionNote}>
              RAD (Rider Area Distance): from the center of the bottom bracket to the middle of your grips, measured on your
              bike.
            </AppText>
            <MeasurementField
              label="RAD"
              kind="length"
              units={profile.units}
              canonical={profile.radCm}
              onCommit={(radCm) => store.saveProfile({ radCm })}
            />
          </Card>

          <Card style={styles.section}>
            <View style={styles.aboutRow}>
              <AppText weight="semi" size={13}>
                Version
              </AppText>
              <NumberText size={13} color={tokens.textMuted}>
                {version}
              </NumberText>
            </View>
          </Card>
        </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function SegmentButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.segment, active && styles.segmentActive]}
    >
      <AppText size={12} weight="bold" color={active ? tokens.electric : tokens.textMuted}>
        {label}
      </AppText>
    </Pressable>
  );
}

type MeasurementFieldProps = {
  label: string;
  kind: MeasureKind;
  units: UnitSystem;
  canonical: number | undefined;
  onCommit: (canonical: number | undefined) => void;
};

function MeasurementField({ label, kind, units, canonical, onCommit }: MeasurementFieldProps) {
  const display = toDisplay(canonical, kind, units);
  const [draft, setDraft] = useState(display !== undefined ? formatValue(display) : "");

  // Re-derive the draft when the units toggle or stored value changes.
  useEffect(() => {
    setDraft(display !== undefined ? formatValue(display) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, canonical]);

  function commit() {
    const cleaned = draft.trim().replace(",", ".");
    if (!cleaned) {
      onCommit(undefined);
      return;
    }
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(display !== undefined ? formatValue(display) : "");
      return;
    }
    onCommit(Math.round(toCanonical(parsed, kind, units) * 10) / 10);
  }

  return (
    <View style={styles.fieldRow}>
      <AppText weight="semi" size={13} style={styles.fieldLabel}>
        {label}
      </AppText>
      <View style={styles.fieldInputWrap}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onEndEditing={commit}
          keyboardType="decimal-pad"
          placeholder="—"
          placeholderTextColor={tokens.textMuted}
          style={styles.fieldInput}
        />
        <AppText size={12} weight="bold" color={tokens.textMuted} style={styles.unitLabel}>
          {unitLabel(kind, units)}
        </AppText>
      </View>
    </View>
  );
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const styles = StyleSheet.create({
  sheetRoot: {
    flex: 1,
    backgroundColor: tokens.background
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md
  },
  sheetClose: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: tokens.surfaceMuted
  },
  keyboardArea: {
    flex: 1
  },
  content: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  section: {
    gap: spacing.md
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  sectionNote: {
    lineHeight: 17
  },
  riderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: tokens.surfaceMuted
  },
  avatarPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: tokens.border
  },
  riderFields: {
    flex: 1,
    gap: spacing.xs
  },
  nameInput: {
    minHeight: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: spacing.md,
    fontFamily: tokens.fontUi,
    fontSize: 15,
    color: tokens.text
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: tokens.surfaceMuted,
    borderRadius: radius.pill,
    padding: 3,
    gap: 2
  },
  segment: {
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  segmentActive: {
    backgroundColor: tokens.graphite
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  fieldLabel: {
    flexShrink: 0
  },
  fieldInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  fieldInput: {
    // Fixed width so every measurement box lines up across rows.
    width: 96,
    minHeight: 40,
    textAlign: "right",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingHorizontal: spacing.md,
    fontFamily: tokens.fontMono,
    fontSize: 15,
    color: tokens.text
  },
  unitLabel: {
    // Fixed unit column ("cm"/"kg"/"in"/"lbs") keeps the boxes' right edges aligned.
    width: 28
  },
  aboutRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  }
});
