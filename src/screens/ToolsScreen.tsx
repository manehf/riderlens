import { AlertTriangle, Gauge, Ruler, Save, SlidersHorizontal } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { AppText, BrandHeader, Button, Card, Chip, Heading, MetricTile, NumberText, SectionHeader } from "../components/ui";
import { useInclinometer } from "../hooks/useInclinometer";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { spacing, tokens } from "../theme/tokens";

type ToolsScreenProps = {
  store: RiderLensStore;
};

const measurementTypes = ["Ramp angle", "Brake lever angle", "Saddle angle", "Landing slope"] as const;

export function ToolsScreen({ store }: ToolsScreenProps) {
  const inclinometer = useInclinometer();
  const [measurementType, setMeasurementType] = useState<(typeof measurementTypes)[number]>("Ramp angle");
  const [forkTravel, setForkTravel] = useState(100);
  const [sagMm, setSagMm] = useState(12);

  const sagPercent = useMemo(() => Math.round((sagMm / forkTravel) * 100), [forkTravel, sagMm]);

  function saveMeasurement() {
    store.addMeasurement({
      measurementType,
      value: inclinometer.pitch,
      unit: "deg",
      notes: "Saved from phone inclinometer. Placement affects accuracy."
    });
  }

  return (
    <View style={styles.root}>
      <BrandHeader subtitle="Rider tools" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionHeader
          eyebrow="Tools"
          title="Level and setup utilities"
          body="Use the phone as a calibrated level, then store useful readings inside the current bike setup."
        />

        <Card tone="dark" style={styles.levelCard}>
          <View style={styles.levelHeader}>
            <Chip tone="electric" icon={Gauge}>
              Inclinometer
            </Chip>
            <Chip tone={inclinometer.available ? "dark" : "amber"}>
              {inclinometer.available ? "Sensors live" : "Sensor fallback"}
            </Chip>
          </View>

          <View style={styles.levelDial}>
            <View style={[styles.levelLine, { transform: [{ rotate: `${inclinometer.roll}deg` }] }]} />
            <View style={styles.levelBubble} />
          </View>

          <View style={styles.levelReadouts}>
            <MetricTile tone="dark" label="Pitch" value={inclinometer.pitch} unit="deg" />
            <MetricTile tone="dark" label="Roll" value={inclinometer.roll} unit="deg" />
            <MetricTile tone="dark" label="Grade" value={inclinometer.gradePercent} unit="%" />
          </View>

          <View style={styles.actionRow}>
            <Button variant="dark" icon={Ruler} onPress={inclinometer.resetZero}>
              Reset Zero
            </Button>
            <Button icon={Save} onPress={saveMeasurement}>
              Save Reading
            </Button>
          </View>
        </Card>

        <Card>
          <Heading level={3}>Measurement type</Heading>
          <View style={styles.measurementTypes}>
            {measurementTypes.map((type) => {
              const selected = measurementType === type;
              return (
                <Pressable
                  key={type}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setMeasurementType(type)}
                  style={[styles.typeChip, selected && styles.typeChipActive]}
                >
                  <AppText weight="bold" size={12} color={selected ? tokens.graphite : tokens.textMuted}>
                    {type}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card>
          <View style={styles.utilityHeader}>
            <SlidersHorizontal color={tokens.green} size={18} />
            <Heading level={3}>Sag calculator</Heading>
          </View>
          <View style={styles.sagGrid}>
            <SagControl label="Fork travel" value={forkTravel} unit="mm" onChange={setForkTravel} step={10} min={60} />
            <SagControl label="Measured sag" value={sagMm} unit="mm" onChange={setSagMm} step={1} min={0} />
          </View>
          <View style={styles.sagResult}>
            <AppText weight="bold">Calculated sag</AppText>
            <NumberText weight="bold" size={30} color={tokens.green}>
              {sagPercent}%
            </NumberText>
          </View>
        </Card>

        <Card style={styles.warningCard}>
          <View style={styles.warningHeader}>
            <AlertTriangle color="#7a4b00" size={18} />
            <AppText weight="bold" color="#704400">
              Sensor accuracy warning
            </AppText>
          </View>
          <AppText color="#704400" size={13}>
            Phone case, camera bump, mount, and placement can change readings. Calibrate on the same reference surface before saving setup data.
          </AppText>
        </Card>
      </ScrollView>
    </View>
  );
}

function SagControl({
  label,
  value,
  unit,
  step,
  min,
  onChange
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.sagControl}>
      <AppText weight="bold">{label}</AppText>
      <View style={styles.sagStepper}>
        <Button variant="secondary" onPress={() => onChange(Math.max(min, value - step))} style={styles.sagButton}>
          -
        </Button>
        <View style={styles.sagValue}>
          <NumberText weight="bold" size={18}>
            {value}
          </NumberText>
          <NumberText color={tokens.textMuted} size={12}>
            {unit}
          </NumberText>
        </View>
        <Button variant="secondary" onPress={() => onChange(value + step)} style={styles.sagButton}>
          +
        </Button>
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
  levelCard: {
    gap: spacing.lg
  },
  levelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md
  },
  levelDial: {
    height: 190,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: tokens.graphite2
  },
  levelLine: {
    width: 240,
    height: 4,
    borderRadius: 999,
    backgroundColor: tokens.electric
  },
  levelBubble: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 3,
    borderColor: tokens.cyan,
    backgroundColor: "rgba(0,184,217,0.24)"
  },
  levelReadouts: {
    flexDirection: "row",
    gap: spacing.sm
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.md
  },
  measurementTypes: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md
  },
  typeChip: {
    minHeight: 36,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 999,
    backgroundColor: tokens.surface,
    paddingHorizontal: spacing.md
  },
  typeChipActive: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electric
  },
  utilityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  sagGrid: {
    gap: spacing.md,
    marginTop: spacing.lg
  },
  sagControl: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md
  },
  sagStepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
  sagButton: {
    minWidth: 42,
    minHeight: 38,
    paddingHorizontal: 0
  },
  sagValue: {
    minWidth: 74,
    alignItems: "center",
    borderRadius: 8,
    backgroundColor: tokens.surfaceMuted,
    paddingVertical: spacing.xs
  },
  sagResult: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    marginTop: spacing.lg,
    paddingTop: spacing.lg
  },
  warningCard: {
    borderColor: "#f2c068",
    backgroundColor: tokens.amberSoft
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xs
  }
});
