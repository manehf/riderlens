import { useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Svg, { Line as SvgLine, Polyline, Text as SvgText } from "react-native-svg";

import { tokens } from "../theme/tokens";
import type { CaptureEvent, SeriesPoint } from "../types/domain";

// Angles plot on a 0..180 axis; hip height (0..1) scales to the same axis; pitch is
// centered on the 90 line so level reads mid-chart. Same conventions as the Lab.

const HEIGHT = 180;
const PAD = { left: 26, right: 6, top: 16, bottom: 16 };

type Curve = {
  key: keyof Pick<SeriesPoint, "kneeAngle" | "torsoAngle" | "hipHeight" | "pitch">;
  color: string;
  transform: (value: number) => number;
};

const curves: Curve[] = [
  { key: "kneeAngle", color: "#8b5cf6", transform: (value) => value },
  { key: "torsoAngle", color: tokens.cyan, transform: (value) => value },
  { key: "hipHeight", color: tokens.green, transform: (value) => value * 180 },
  { key: "pitch", color: tokens.amber, transform: (value) => value + 90 }
];

export function TimelineChart({ series, events }: { series: SeriesPoint[]; events?: CaptureEvent[] }) {
  const [width, setWidth] = useState(0);
  if (series.length < 3) return null;

  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * Math.max(1, width - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (1 - value / 180) * (HEIGHT - PAD.top - PAD.bottom);

  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return (
    <View onLayout={onLayout}>
      {width > 0 ? (
        <Svg width={width} height={HEIGHT}>
          {[0, 90, 180].map((grid) => (
            <SvgLine
              key={grid}
              x1={PAD.left}
              y1={y(grid)}
              x2={width - PAD.right}
              y2={y(grid)}
              stroke={grid === 90 ? tokens.border : "rgba(221,227,218,0.35)"}
              strokeWidth={1}
            />
          ))}
          {[0, 90, 180].map((grid) => (
            <SvgText key={`label-${grid}`} x={2} y={y(grid) + 3} fontSize={9} fill={tokens.textMuted}>
              {grid}
            </SvgText>
          ))}
          {curves.map((curve) => {
            const points = series
              .filter((row) => row[curve.key] != null && (curve.key === "pitch" || row.confidence >= 0.35))
              .map((row) => `${x(row.t).toFixed(1)},${y(curve.transform(row[curve.key] as number)).toFixed(1)}`)
              .join(" ");
            if (!points) return null;
            return <Polyline key={curve.key} points={points} fill="none" stroke={curve.color} strokeWidth={2} />;
          })}
          {(events ?? [])
            .filter((event) => event.time_seconds >= t0 && event.time_seconds <= t1)
            .map((event) => (
              <SvgLine
                key={`${event.name}-${event.time_seconds}`}
                x1={x(event.time_seconds)}
                y1={PAD.top}
                x2={x(event.time_seconds)}
                y2={HEIGHT - PAD.bottom}
                stroke={tokens.textMuted}
                strokeWidth={1}
                strokeDasharray="3,3"
              />
            ))}
          {(events ?? [])
            .filter((event) => event.time_seconds >= t0 && event.time_seconds <= t1)
            .map((event) => (
              <SvgText
                key={`text-${event.name}-${event.time_seconds}`}
                x={Math.min(x(event.time_seconds) + 2, width - 44)}
                y={PAD.top - 5}
                fontSize={9}
                fill={tokens.textMuted}
              >
                {event.name}
              </SvgText>
            ))}
        </Svg>
      ) : null}
    </View>
  );
}
