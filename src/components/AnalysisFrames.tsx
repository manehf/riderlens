import { Video, ResizeMode } from "expo-av";
import { Image as ImageIcon } from "lucide-react-native";
import { useState } from "react";
import { Image as RNImage, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Line as SvgLine } from "react-native-svg";

import { getGeometrySourceLabel, hasVerifiedGeometry, type FrameMediaSource } from "../services/analysis";
import { spacing, tokens } from "../theme/tokens";
import type { FrameGeometry, FrameLine, FramePoint, PoseMetric } from "../types/domain";
import { AppText, Card, Chip, Heading, NumberText } from "./ui";

type AnalysisFramesProps = {
  metrics: PoseMetric[];
  mediaSource?: FrameMediaSource;
  emptyText?: string;
};

const phaseCopy: Record<string, string> = {
  approach: "Speed and body set",
  compression: "Pump into the lip",
  takeoff: "Extension timing",
  air: "Bike and landing alignment",
  landing: "Absorb and center"
};

export function AnalysisFrames({
  metrics,
  mediaSource,
  emptyText = "Analysis frames appear here after processing."
}: AnalysisFramesProps) {
  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Chip tone="cyan" icon={ImageIcon}>
            Analysis frames
          </Chip>
          <Heading level={3}>Key moments</Heading>
        </View>
        {metrics.length > 0 ? (
          <NumberText weight="bold" color={tokens.green}>
            {metrics.length}
          </NumberText>
        ) : null}
      </View>

      {metrics.length === 0 ? (
        <View style={styles.emptyState}>
          <AppText color={tokens.textMuted} size={13}>
            {emptyText}
          </AppText>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.frameStrip}>
          {metrics.map((metric) => (
            <FrameCard key={metric.id} metric={metric} mediaSource={mediaSource} />
          ))}
        </ScrollView>
      )}
    </Card>
  );
}

export function FrameMediaBackground({
  mediaSource,
  frameTime,
  style
}: {
  mediaSource?: FrameMediaSource;
  frameTime: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [failed, setFailed] = useState(false);
  const positionMillis = Math.max(0, Math.round(frameTime * 1000));

  if (failed || (!mediaSource?.videoUri && !mediaSource?.imageUri)) {
    return null;
  }

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.mediaLayer, style]}>
      {mediaSource.videoUri ? (
        <Video
          source={{ uri: mediaSource.videoUri }}
          resizeMode={ResizeMode.COVER}
          shouldPlay={false}
          isMuted
          volume={0}
          positionMillis={positionMillis}
          progressUpdateIntervalMillis={1000}
          useNativeControls={false}
          onError={() => setFailed(true)}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        <RNImage
          source={{ uri: mediaSource.imageUri }}
          resizeMode="cover"
          onError={() => setFailed(true)}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View style={styles.mediaScrim} />
    </View>
  );
}

function FrameCard({ metric, mediaSource }: { metric: PoseMetric; mediaSource?: FrameMediaSource }) {
  const verifiedGeometry = hasVerifiedGeometry(metric);

  return (
    <View style={styles.frameCard}>
      <View style={styles.frameSurface}>
        <FrameMediaBackground mediaSource={mediaSource} frameTime={metric.frameTime} />
        <View style={styles.gridLineOne} />
        <View style={styles.gridLineTwo} />
        {verifiedGeometry ? <FrameGeometryOverlay metric={metric} variant="compact" /> : <CalibrationOverlay />}
        <View style={styles.frameTime}>
          <NumberText weight="bold" color={tokens.electric} size={12}>
            {metric.frameTime.toFixed(1)}s
          </NumberText>
        </View>
      </View>

      <View style={styles.frameBody}>
        <View style={styles.frameTitleRow}>
          <AppText weight="bold" size={13} style={styles.phaseName}>
            {metric.phase}
          </AppText>
          <Chip tone={verifiedGeometry ? "green" : "amber"}>{getGeometrySourceLabel(metric)}</Chip>
        </View>
        <AppText color={tokens.textMuted} size={12}>
          {verifiedGeometry ? phaseCopy[metric.phase] ?? "Review frame" : "Mark floor, tire baseline, torso, knee, and landing alignment."}
        </AppText>
        <View style={styles.frameMetrics}>
          <View>
            <AppText weight="bold" color={tokens.textMuted} size={10} style={styles.uppercase}>
              Floor
            </AppText>
            <NumberText weight="bold" size={13}>
              {(metric.floorAngle ?? 0).toFixed(0)} deg
            </NumberText>
          </View>
          <View>
            <AppText weight="bold" color={tokens.textMuted} size={10} style={styles.uppercase}>
              Knee
            </AppText>
            <NumberText weight="bold" size={13}>
              {metric.kneeAngle} deg
            </NumberText>
          </View>
        </View>
      </View>
    </View>
  );
}

function CalibrationOverlay() {
  return (
    <View style={styles.calibrationOverlay}>
      <View style={styles.calibrationPanel}>
        <AppText weight="bold" size={12} color={tokens.surface}>
          Calibration required
        </AppText>
        <AppText size={11} color="rgba(255,255,255,0.72)">
          Detector not connected
        </AppText>
      </View>
    </View>
  );
}

export function FrameGeometryOverlay({
  metric,
  variant = "compact",
  showLabels = false
}: {
  metric: PoseMetric;
  variant?: "compact" | "large";
  showLabels?: boolean;
}) {
  if (metric.geometry) {
    return <NormalizedGeometryOverlay geometry={metric.geometry} variant={variant} showLabels={showLabels} />;
  }

  const lineSet = variant === "large" ? largeGeometryLines : compactGeometryLines;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.geometryLine, styles.floorLine, lineSet.floor, { transform: [{ rotate: `${metric.floorAngle ?? -5}deg` }] }]} />
      <View
        style={[
          styles.geometryLine,
          styles.tireBaselineLine,
          lineSet.tireBaseline,
          { transform: [{ rotate: `${metric.tireBaselineAngle ?? metric.bikePitchAngle}deg` }] }
        ]}
      />
      <View
        style={[
          styles.geometryLine,
          styles.torsoLine,
          lineSet.torso,
          { transform: [{ rotate: `${metric.torsoAngle - 66}deg` }] }
        ]}
      />
      <View style={[styles.geometryLine, styles.kneeLine, lineSet.kneeUpper]} />
      <View style={[styles.geometryLine, styles.kneeLine, lineSet.kneeLower]} />
      <View
        style={[
          styles.geometryLine,
          styles.landingLine,
          lineSet.landing,
          { transform: [{ rotate: `${metric.landingAlignmentAngle ?? 8}deg` }] }
        ]}
      />

      {showLabels ? (
        <>
          <GeometryLabel label="Floor" style={lineSet.floorLabel} />
          <GeometryLabel label="Tire baseline" style={lineSet.tireLabel} />
          <GeometryLabel label="Torso" style={lineSet.torsoLabel} />
          <GeometryLabel label="Knee" style={lineSet.kneeLabel} />
          <GeometryLabel label="Landing align" style={lineSet.landingLabel} />
        </>
      ) : null}
    </View>
  );
}

function NormalizedGeometryOverlay({
  geometry,
  variant,
  showLabels
}: {
  geometry: FrameGeometry;
  variant: "compact" | "large";
  showLabels: boolean;
}) {
  const strokeWidth = variant === "large" ? 1.25 : 1.05;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 100 100" preserveAspectRatio="none">
        <SvgGeometryLine line={geometry.floor} color="rgba(255,255,255,0.92)" strokeWidth={strokeWidth} />
        <SvgGeometryLine line={geometry.tireBaseline} color={tokens.electric} strokeWidth={strokeWidth} />
        <SvgGeometryLine line={geometry.torso} color={tokens.cyan} strokeWidth={strokeWidth} />
        <SvgGeometryLine line={geometry.kneeUpper} color="#f6ff63" strokeWidth={strokeWidth} />
        <SvgGeometryLine line={geometry.kneeLower} color="#f6ff63" strokeWidth={strokeWidth} />
        <SvgGeometryLine line={geometry.landing} color="#ff4fd8" strokeWidth={strokeWidth} />
      </Svg>

      {showLabels ? (
        <>
          <GeometryLabel label="Floor" style={getGeometryLabelStyle(getMidpoint(geometry.floor))} />
          <GeometryLabel label="Tire baseline" style={getGeometryLabelStyle(getMidpoint(geometry.tireBaseline))} />
          <GeometryLabel label="Torso" style={getGeometryLabelStyle(getMidpoint(geometry.torso))} />
          <GeometryLabel label="Knee" style={getGeometryLabelStyle(geometry.kneeUpper.end)} />
          <GeometryLabel label="Landing align" style={getGeometryLabelStyle(getMidpoint(geometry.landing))} />
        </>
      ) : null}
    </View>
  );
}

function SvgGeometryLine({
  line,
  color,
  strokeWidth
}: {
  line: FrameLine;
  color: string;
  strokeWidth: number;
}) {
  return (
    <SvgLine
      x1={line.start.x * 100}
      y1={line.start.y * 100}
      x2={line.end.x * 100}
      y2={line.end.y * 100}
      stroke={color}
      strokeLinecap="round"
      strokeWidth={strokeWidth}
    />
  );
}

function getMidpoint(line: FrameLine): FramePoint {
  return {
    x: (line.start.x + line.end.x) / 2,
    y: (line.start.y + line.end.y) / 2
  };
}

function getGeometryLabelStyle(point: FramePoint): ViewStyle {
  return {
    left: `${point.x * 100}%`,
    top: `${point.y * 100}%`
  };
}

function GeometryLabel({ label, style }: { label: string; style: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.geometryLabel, style]}>
      <AppText weight="bold" size={10} color={tokens.surface}>
        {label}
      </AppText>
    </View>
  );
}

const compactGeometryLines = {
  floor: { left: "9%", top: "75%", width: "82%" },
  tireBaseline: { left: "32%", top: "50%", width: "38%" },
  torso: { left: "48%", top: "29%", width: "24%" },
  kneeUpper: { left: "49%", top: "52%", width: "21%", transform: [{ rotate: "128deg" }] },
  kneeLower: { left: "43%", top: "65%", width: "23%", transform: [{ rotate: "-36deg" }] },
  landing: { left: "55%", top: "34%", width: "38%" },
  floorLabel: { left: "10%", top: "68%" },
  tireLabel: { left: "30%", top: "43%" },
  torsoLabel: { left: "58%", top: "24%" },
  kneeLabel: { left: "44%", top: "57%" },
  landingLabel: { right: "8%", top: "27%" }
} satisfies Record<string, StyleProp<ViewStyle>>;

const largeGeometryLines = {
  floor: { left: "7%", top: "78%", width: "86%" },
  tireBaseline: { left: "31%", top: "52%", width: "40%" },
  torso: { left: "47%", top: "27%", width: "27%" },
  kneeUpper: { left: "48%", top: "51%", width: "23%", transform: [{ rotate: "128deg" }] },
  kneeLower: { left: "42%", top: "65%", width: "26%", transform: [{ rotate: "-34deg" }] },
  landing: { left: "54%", top: "35%", width: "41%" },
  floorLabel: { left: "8%", top: "70%" },
  tireLabel: { left: "29%", top: "44%" },
  torsoLabel: { left: "58%", top: "20%" },
  kneeLabel: { left: "43%", top: "57%" },
  landingLabel: { right: "7%", top: "28%" }
} satisfies Record<string, StyleProp<ViewStyle>>;

const styles = StyleSheet.create({
  card: {
    gap: spacing.lg,
    paddingHorizontal: 0
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.lg
  },
  titleBlock: {
    gap: spacing.sm
  },
  emptyState: {
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md
  },
  frameStrip: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs
  },
  frameCard: {
    width: 218,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 8,
    backgroundColor: tokens.surface
  },
  frameSurface: {
    height: 142,
    overflow: "hidden",
    backgroundColor: tokens.graphite2
  },
  mediaLayer: {
    overflow: "hidden"
  },
  mediaScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(9,13,15,0.28)"
  },
  gridLineOne: {
    position: "absolute",
    top: 44,
    right: 0,
    left: 0,
    height: 1,
    backgroundColor: "rgba(182,255,46,0.08)"
  },
  gridLineTwo: {
    position: "absolute",
    top: 88,
    right: 0,
    left: 0,
    height: 1,
    backgroundColor: "rgba(182,255,46,0.08)"
  },
  targetRing: {
    position: "absolute",
    left: 72,
    top: 31,
    width: 82,
    height: 82,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(182,255,46,0.36)"
  },
  wheel: {
    position: "absolute",
    width: 24,
    height: 24,
    borderRadius: 999,
    borderWidth: 3,
    borderColor: tokens.surface
  },
  wheelOne: {
    left: 45,
    top: 84
  },
  wheelTwo: {
    left: 125,
    top: 80
  },
  bikeLine: {
    position: "absolute",
    left: 52,
    top: 82,
    width: 96,
    height: 4,
    borderRadius: 999,
    backgroundColor: tokens.electric
  },
  poseLine: {
    position: "absolute",
    borderRadius: 999,
    backgroundColor: tokens.cyan
  },
  poseBack: {
    left: 93,
    top: 45,
    width: 4,
    height: 49
  },
  poseArm: {
    left: 101,
    top: 60,
    width: 40,
    height: 4,
    transform: [{ rotate: "17deg" }]
  },
  poseLeg: {
    left: 84,
    top: 91,
    width: 42,
    height: 4,
    transform: [{ rotate: "-31deg" }]
  },
  rampLine: {
    position: "absolute",
    right: 15,
    bottom: 28,
    width: 92,
    height: 24,
    borderBottomWidth: 4,
    borderBottomColor: "rgba(255,255,255,0.72)",
    transform: [{ rotate: "-12deg" }]
  },
  geometryLine: {
    position: "absolute",
    height: 3,
    borderRadius: 999
  },
  floorLine: {
    backgroundColor: "rgba(255,255,255,0.88)"
  },
  tireBaselineLine: {
    backgroundColor: tokens.electric
  },
  torsoLine: {
    backgroundColor: tokens.cyan
  },
  kneeLine: {
    backgroundColor: "#f6ff63"
  },
  landingLine: {
    backgroundColor: "#ff4fd8"
  },
  geometryLabel: {
    position: "absolute",
    marginLeft: 6,
    marginTop: -12,
    borderRadius: 999,
    backgroundColor: "rgba(9,13,15,0.78)",
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  calibrationOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.md
  },
  calibrationPanel: {
    alignItems: "center",
    gap: 3,
    borderWidth: 1,
    borderColor: "rgba(182,255,46,0.36)",
    borderRadius: 8,
    backgroundColor: "rgba(9,13,15,0.76)",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  frameTime: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(182,255,46,0.32)",
    backgroundColor: "rgba(17,22,19,0.72)",
    paddingHorizontal: 9,
    paddingVertical: 4
  },
  frameBody: {
    gap: spacing.sm,
    padding: spacing.md
  },
  frameTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm
  },
  phaseName: {
    textTransform: "capitalize"
  },
  frameMetrics: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.sm
  },
  uppercase: {
    textTransform: "uppercase"
  }
});
