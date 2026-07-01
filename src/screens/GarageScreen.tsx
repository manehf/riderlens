import { Bike, ChevronDown, ChevronUp, LockKeyhole, Share2, Wrench } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";

import { AppText, BrandHeader, Button, Card, Chip, Heading, MetricTile, NumberText, SectionHeader } from "../components/ui";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { numericText, spacing, tokens } from "../theme/tokens";
import type { PermissionLevel } from "../types/domain";

type GarageScreenProps = {
  store: RiderLensStore;
};

export function GarageScreen({ store }: GarageScreenProps) {
  const { garage } = store;
  const [notes, setNotes] = useState(garage.setup.notes);

  useEffect(() => {
    setNotes(garage.setup.notes);
  }, [garage.setup.notes]);

  return (
    <View style={styles.root}>
      <BrandHeader subtitle="Garage setup" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionHeader
          eyebrow="Garage"
          title="Bike setup sheet"
          body="A calm, shareable setup record for riders, coaches, shops, and mechanics."
        />

        <Card style={styles.sheet}>
          <View style={styles.sheetHead}>
            <View style={styles.sheetTitleBlock}>
              <View style={styles.brandMini}>
                <View style={styles.brandMiniMark}>
                  <AppText weight="bold" size={12} color={tokens.electric}>
                    RL
                  </AppText>
                </View>
                <View>
                  <AppText weight="bold">RiderLens</AppText>
                  <AppText weight="semi" size={12} color={tokens.textMuted}>
                    Setup sheet
                  </AppText>
                </View>
              </View>
              <Heading level={2}>{garage.setup.name}</Heading>
              <AppText color={tokens.textMuted}>
                {garage.bike.year} {garage.bike.brand} {garage.bike.model} · {garage.bike.discipline}
              </AppText>
            </View>
            <View style={styles.updatedBlock}>
              <AppText weight="bold" size={11} color={tokens.textMuted} style={styles.uppercase}>
                Updated
              </AppText>
              <NumberText weight="bold" size={13}>
                {new Date(garage.setup.updatedAt).toLocaleDateString()}
              </NumberText>
              <Chip tone="green">Current</Chip>
            </View>
          </View>

          <View style={styles.feedback}>
            <AppText weight="bold" size={11} color={tokens.textMuted} style={styles.uppercase}>
              Rider feedback
            </AppText>
            <TextInput
              multiline
              value={notes}
              onChangeText={setNotes}
              onBlur={() => store.saveSetupNote(notes)}
              placeholder="What feels harsh, unstable, or different?"
              placeholderTextColor={tokens.textMuted}
              style={styles.notesInput}
            />
          </View>

          <View style={styles.sheetSection}>
            <SectionLabel title="Suspension" icon={Wrench} />
            <NumberControl
              label="Fork pressure"
              value={garage.suspension.forkPressure}
              unit="psi"
              step={2}
              onChange={(value) => store.saveSuspensionValue("forkPressure", value)}
            />
            <NumberControl
              label="Fork rebound"
              value={garage.suspension.forkReboundClicks}
              unit="clicks"
              step={1}
              onChange={(value) => store.saveSuspensionValue("forkReboundClicks", value)}
            />
            <NumberControl
              label="Fork LSC"
              value={garage.suspension.forkLscClicks}
              unit="clicks"
              step={1}
              onChange={(value) => store.saveSuspensionValue("forkLscClicks", value)}
            />
          </View>

          <View style={styles.metricRows}>
            <MetricTile label="Fork sag" value={garage.suspension.forkSagPercent} unit="%" />
            <MetricTile label="Tokens" value={garage.suspension.forkTokens} />
            <MetricTile label="Rider" value={garage.setup.riderWeightWithGear} unit="kg" />
          </View>

          <View style={styles.sheetSection}>
            <SectionLabel title="Tires and cockpit" icon={Bike} />
            <SetupRow label="Front tire" value={`${garage.tires.frontTirePressure}`} unit="psi" detail={garage.tires.frontTireModel} />
            <SetupRow label="Rear tire" value={`${garage.tires.rearTirePressure}`} unit="psi" detail={garage.tires.rearTireModel} />
            <SetupRow label="Brake lever" value={`${garage.cockpit.brakeLeverAngle}`} unit="deg" detail="Measured standing" />
            <SetupRow label="Bar width" value={`${garage.cockpit.barWidth}`} unit="mm" detail="Current cockpit" />
          </View>

          <View style={styles.sheetSection}>
            <SectionLabel title="Service" icon={Wrench} />
            {garage.services.map((service) => (
              <View key={service.id} style={styles.serviceRow}>
                <View style={styles.serviceText}>
                  <AppText weight="bold">{service.serviceType}</AppText>
                  <AppText color={tokens.textMuted} size={13}>
                    {service.shopName} · {service.mechanicName}
                  </AppText>
                </View>
                <View style={styles.serviceDate}>
                  <NumberText weight="bold" size={13}>
                    {service.serviceDate}
                  </NumberText>
                  <NumberText size={12} color={tokens.textMuted}>
                    {service.odometerOrHours}h
                  </NumberText>
                </View>
              </View>
            ))}
          </View>
        </Card>

        <Card style={styles.permissionsCard}>
          <View style={styles.permissionHeader}>
            <LockKeyhole color={tokens.green} size={18} />
            <View style={styles.permissionText}>
              <AppText weight="bold">Explicit sharing permissions</AppText>
              <AppText color={tokens.textMuted} size={13}>
                A shop or mechanic can view this setup, but edit access must be granted intentionally.
              </AppText>
            </View>
          </View>
          <View style={styles.permissionActions}>
            {(["view", "comment", "edit"] as PermissionLevel[]).map((permission) => (
              <Button
                key={permission}
                variant={permission === "edit" ? "dark" : "secondary"}
                icon={Share2}
                onPress={() => store.shareSetupSheet(permission)}
                style={styles.permissionButton}
              >
                {permission}
              </Button>
            ))}
          </View>
        </Card>

        <Card>
          <SectionLabel title="Saved measurements" icon={ChevronDown} />
          <View style={styles.measurementList}>
            {garage.measurements.map((measurement) => (
              <View key={measurement.id} style={styles.measurementRow}>
                <View>
                  <AppText weight="bold">{measurement.measurementType}</AppText>
                  <AppText color={tokens.textMuted} size={13}>
                    {measurement.notes}
                  </AppText>
                </View>
                <NumberText weight="bold" color={tokens.green}>
                  {measurement.value}{measurement.unit}
                </NumberText>
              </View>
            ))}
          </View>
        </Card>
      </ScrollView>
    </View>
  );
}

function SectionLabel({ title, icon: Icon }: { title: string; icon: typeof Wrench }) {
  return (
    <View style={styles.sectionLabel}>
      <Icon color={tokens.green} size={16} strokeWidth={2.4} />
      <AppText weight="bold" size={12} color={tokens.textMuted} style={styles.uppercase}>
        {title}
      </AppText>
    </View>
  );
}

function NumberControl({
  label,
  value,
  unit,
  step,
  onChange
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.controlRow}>
      <View style={styles.controlLabel}>
        <AppText weight="bold">{label}</AppText>
        <NumberText color={tokens.textMuted} size={12}>
          {step} {unit} step
        </NumberText>
      </View>
      <View style={styles.stepper}>
        <Button variant="secondary" icon={ChevronDown} onPress={() => onChange(Math.max(0, value - step))} style={styles.stepButton}>
          -
        </Button>
        <View style={styles.stepValue}>
          <NumberText weight="bold" size={18}>
            {value}
          </NumberText>
          <NumberText color={tokens.textMuted} size={12}>
            {unit}
          </NumberText>
        </View>
        <Button variant="secondary" icon={ChevronUp} onPress={() => onChange(value + step)} style={styles.stepButton}>
          +
        </Button>
      </View>
    </View>
  );
}

function SetupRow({ label, value, unit, detail }: { label: string; value: string; unit: string; detail: string }) {
  return (
    <View style={styles.setupRow}>
      <View>
        <AppText weight="bold">{label}</AppText>
        <AppText color={tokens.textMuted} size={13}>
          {detail}
        </AppText>
      </View>
      <View style={styles.setupValue}>
        <NumberText weight="bold" size={18}>
          {value}
        </NumberText>
        <NumberText color={tokens.textMuted} size={12}>
          {unit}
        </NumberText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  },
  content: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: 120
  },
  sheet: {
    padding: 0,
    overflow: "hidden"
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.border,
    padding: spacing.lg
  },
  sheetTitleBlock: {
    flex: 1,
    gap: spacing.sm
  },
  brandMini: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  brandMiniMark: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: tokens.graphite
  },
  updatedBlock: {
    alignItems: "flex-end",
    gap: spacing.xs
  },
  uppercase: {
    textTransform: "uppercase"
  },
  feedback: {
    gap: spacing.xs,
    margin: spacing.lg,
    borderLeftWidth: 5,
    borderLeftColor: tokens.cyan,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 8,
    backgroundColor: "#fbfdfd",
    padding: spacing.md
  },
  notesInput: {
    minHeight: 78,
    color: tokens.text,
    fontFamily: tokens.fontUiSemiBold,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: "top"
  },
  sheetSection: {
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    padding: spacing.lg
  },
  sectionLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  metricRows: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg
  },
  controlRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  controlLabel: {
    flex: 1,
    gap: 2
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  stepButton: {
    minWidth: 42,
    minHeight: 38,
    paddingHorizontal: 0
  },
  stepValue: {
    minWidth: 72,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: tokens.surfaceMuted,
    paddingVertical: spacing.xs
  },
  setupRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.md
  },
  setupValue: {
    alignItems: "flex-end"
  },
  serviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.md
  },
  serviceText: {
    flex: 1
  },
  serviceDate: {
    alignItems: "flex-end"
  },
  permissionsCard: {
    gap: spacing.lg
  },
  permissionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md
  },
  permissionText: {
    flex: 1,
    gap: spacing.xs
  },
  permissionActions: {
    flexDirection: "row",
    gap: spacing.sm
  },
  permissionButton: {
    flex: 1,
    minHeight: 42,
    paddingHorizontal: spacing.sm
  },
  measurementList: {
    gap: spacing.md,
    marginTop: spacing.md
  },
  measurementRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.md
  }
});
