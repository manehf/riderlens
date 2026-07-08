import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { LucideProps } from "lucide-react-native";

import { numericText, numericTextBold, radius, shadows, spacing, tokens } from "../theme/tokens";

type IconType = ComponentType<LucideProps>;

type TextProps = PropsWithChildren<{
  color?: string;
  size?: number;
  weight?: "regular" | "semi" | "bold";
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}>;

export function AppText({ children, color = tokens.text, size = 15, weight = "regular", style, numberOfLines }: TextProps) {
  const fontFamily =
    weight === "bold" ? tokens.fontUiBold : weight === "semi" ? tokens.fontUiSemiBold : tokens.fontUi;

  return (
    <Text numberOfLines={numberOfLines} style={[styles.text, { color, fontSize: size, fontFamily }, style]}>
      {children}
    </Text>
  );
}

export function MonoText({
  children,
  color = tokens.text,
  size = 15,
  weight = "regular",
  style,
  numberOfLines
}: TextProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        styles.text,
        weight === "bold" ? numericTextBold : numericText,
        { color, fontSize: size },
        style
      ]}
    >
      {children}
    </Text>
  );
}

export function NumberText(props: TextProps) {
  return <MonoText {...props} />;
}

/** Display face for the loud moments: wordmark and screen titles only.
 * Body text stays on Plex — this is the poster voice, not the reading voice. */
export function DisplayText({ children, color = tokens.text, size = 26, style, numberOfLines }: TextProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[{ fontFamily: tokens.fontDisplay, fontSize: size, color, letterSpacing: 0.5 }, style]}
    >
      {children}
    </Text>
  );
}

type HeadingProps = PropsWithChildren<{
  level?: 1 | 2 | 3;
  style?: StyleProp<TextStyle>;
}>;

export function Heading({ children, level = 2, style }: HeadingProps) {
  const size = level === 1 ? 32 : level === 2 ? 22 : 16;
  const lineHeight = level === 1 ? 36 : level === 2 ? 26 : 20;
  return (
    <AppText weight="bold" size={size} style={[{ lineHeight }, style]}>
      {children}
    </AppText>
  );
}

type ButtonProps = PropsWithChildren<{
  onPress?: () => void;
  variant?: "primary" | "secondary" | "dark" | "danger";
  /** "sm" tightens padding and type so several buttons share a row without wrapping. */
  size?: "md" | "sm";
  icon?: IconType;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}>;

export function Button({
  children,
  onPress,
  variant = "primary",
  size = "md",
  icon: Icon,
  disabled = false,
  accessibilityLabel,
  style
}: ButtonProps) {
  const variantStyle =
    variant === "secondary"
      ? styles.buttonSecondary
      : variant === "dark"
        ? styles.buttonDark
        : variant === "danger"
          ? styles.buttonDanger
          : styles.buttonPrimary;
  const textColor =
    variant === "secondary"
      ? tokens.text
      : variant === "dark"
        ? tokens.electric
        : variant === "danger"
          ? tokens.surface
          : tokens.graphite;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        size === "sm" && styles.buttonSm,
        variantStyle,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style
      ]}
    >
      {Icon ? <Icon color={textColor} size={size === "sm" ? 15 : 18} strokeWidth={2.4} /> : null}
      <AppText weight="bold" size={size === "sm" ? 13 : 15} color={textColor} numberOfLines={1}>
        {children}
      </AppText>
    </Pressable>
  );
}

type ChipTone = "electric" | "cyan" | "green" | "amber" | "red" | "neutral" | "dark";

type ChipProps = PropsWithChildren<{
  tone?: ChipTone;
  icon?: IconType;
  style?: StyleProp<ViewStyle>;
}>;

export function Chip({ children, tone = "neutral", icon: Icon, style }: ChipProps) {
  const config = chipColors[tone];
  return (
    <View style={[styles.chip, { backgroundColor: config.background, borderColor: config.border }, style]}>
      {Icon ? <Icon color={config.color} size={13} strokeWidth={2.4} /> : null}
      <AppText weight="bold" size={12} color={config.color} style={styles.chipText}>
        {children}
      </AppText>
    </View>
  );
}

const chipColors: Record<ChipTone, { background: string; color: string; border: string }> = {
  electric: { background: tokens.electric, color: tokens.graphite, border: tokens.electric },
  cyan: { background: tokens.cyanSoft, color: "#006b82", border: tokens.cyanSoft },
  green: { background: tokens.electricSoft, color: tokens.green, border: tokens.electricSoft },
  amber: { background: tokens.amberSoft, color: "#7a4b00", border: tokens.amberSoft },
  red: { background: tokens.redSoft, color: "#9a2424", border: tokens.redSoft },
  neutral: { background: tokens.surfaceMuted, color: tokens.textMuted, border: tokens.surfaceMuted },
  dark: { background: tokens.graphite, color: tokens.electric, border: "rgba(182, 255, 46, 0.32)" }
};

type CardProps = PropsWithChildren<{
  tone?: "light" | "dark";
  style?: StyleProp<ViewStyle>;
}>;

export function Card({ children, tone = "light", style }: CardProps) {
  return <View style={[styles.card, tone === "dark" && styles.darkCard, style]}>{children}</View>;
}

type ScreenProps = PropsWithChildren<{
  insetBottom?: number;
}>;

export function Screen({ children, insetBottom = 96 }: ScreenProps) {
  return <View style={[styles.screen, { paddingBottom: insetBottom }]}>{children}</View>;
}

type SectionHeaderProps = {
  eyebrow?: string;
  title: string;
  body?: string;
  action?: ReactNode;
};

export function SectionHeader({ eyebrow, title, body, action }: SectionHeaderProps) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleWrap}>
        {eyebrow ? (
          <View style={styles.eyebrowRow}>
            <View style={styles.eyebrowDot} />
            <AppText weight="bold" size={12} color={tokens.green} style={styles.uppercase}>
              {eyebrow}
            </AppText>
          </View>
        ) : null}
        <Heading level={2}>{title}</Heading>
        {body ? (
          <AppText color={tokens.textMuted} size={14} style={styles.sectionBody}>
            {body}
          </AppText>
        ) : null}
      </View>
      {action}
    </View>
  );
}

type MetricTileProps = {
  label: string;
  value: string | number;
  unit?: string;
  tone?: "light" | "dark";
};

export function MetricTile({ label, value, unit, tone = "light" }: MetricTileProps) {
  const dark = tone === "dark";
  return (
    <View style={[styles.metricTile, dark && styles.metricTileDark]}>
      <AppText weight="bold" size={11} color={dark ? "rgba(255,255,255,0.64)" : tokens.textMuted} style={styles.uppercase}>
        {label}
      </AppText>
      <View style={styles.metricValueRow}>
        <NumberText weight="bold" size={22} color={dark ? tokens.surface : tokens.text}>
          {value}
        </NumberText>
        {unit ? (
          <NumberText weight="bold" size={13} color={dark ? tokens.electric : tokens.green}>
            {unit}
          </NumberText>
        ) : null}
      </View>
    </View>
  );
}

type BrandHeaderProps = {
  subtitle?: string;
  action?: ReactNode;
};

export function BrandHeader({ subtitle, action }: BrandHeaderProps) {
  return (
    <View style={styles.brandHeader}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <AppText weight="bold" size={13} color={tokens.electric}>
            RL
          </AppText>
        </View>
        <View>
          <DisplayText size={26}>RIDERLENS</DisplayText>
          {subtitle ? (
            <AppText weight="semi" size={12} color={tokens.textMuted}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
      </View>
      {action}
    </View>
  );
}

export type TabItem = {
  key: string;
  label: string;
  icon: IconType;
};

type BottomTabsProps = {
  items: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  /** Prominent center action (e.g. quick capture) rendered between the tabs. */
  centerAction?: { icon: IconType; label: string; onPress: () => void };
};

export function BottomTabs({ items, activeKey, onChange, centerAction }: BottomTabsProps) {
  const middle = Math.ceil(items.length / 2);
  const ActionIcon = centerAction?.icon;

  const renderTab = (item: TabItem) => {
    const active = item.key === activeKey;
    const Icon = item.icon;
    return (
      <Pressable
        key={item.key}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={item.label}
        onPress={() => onChange(item.key)}
        style={styles.tabItem}
      >
        <View style={[styles.tabIcon, active && styles.tabIconActive]}>
          <Icon color={active ? tokens.graphite : tokens.textMuted} size={18} strokeWidth={2.5} />
        </View>
        <AppText weight="bold" size={11} color={active ? tokens.green : tokens.textMuted}>
          {item.label}
        </AppText>
      </Pressable>
    );
  };

  return (
    <View style={styles.tabBar}>
      {items.slice(0, middle).map(renderTab)}
      {centerAction && ActionIcon ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={centerAction.label}
          onPress={centerAction.onPress}
          style={({ pressed }) => [styles.tabAction, pressed && styles.pressed]}
        >
          <ActionIcon color={tokens.graphite} size={24} strokeWidth={2.6} />
        </Pressable>
      ) : null}
      {items.slice(middle).map(renderTab)}
    </View>
  );
}

const styles = StyleSheet.create({
  text: {
    letterSpacing: 0
  },
  screen: {
    flex: 1,
    backgroundColor: tokens.background
  },
  button: {
    minHeight: 48,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderWidth: 1
  },
  buttonSm: {
    minHeight: 38,
    gap: 6,
    paddingHorizontal: spacing.sm
  },
  buttonPrimary: {
    backgroundColor: tokens.electric,
    borderColor: tokens.electric,
    ...shadows.card
  },
  buttonSecondary: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border
  },
  buttonDark: {
    backgroundColor: tokens.graphite,
    borderColor: tokens.graphite
  },
  buttonDanger: {
    backgroundColor: tokens.red,
    borderColor: tokens.red
  },
  disabled: {
    opacity: 0.48
  },
  pressed: {
    transform: [{ scale: 0.985 }]
  },
  chip: {
    minHeight: 28,
    alignItems: "center",
    flexDirection: "row",
    alignSelf: "flex-start",
    gap: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10
  },
  chipText: {
    lineHeight: 16
  },
  card: {
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: radius.sm,
    backgroundColor: tokens.surface,
    padding: spacing.lg
  },
  darkCard: {
    borderColor: tokens.graphite,
    backgroundColor: tokens.graphite
  },
  sectionHeader: {
    gap: spacing.md,
    marginBottom: spacing.lg
  },
  sectionTitleWrap: {
    gap: spacing.xs
  },
  sectionBody: {
    lineHeight: 20
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9
  },
  eyebrowDot: {
    width: 13,
    height: 13,
    borderRadius: radius.pill,
    borderWidth: 3,
    borderColor: tokens.electric,
    backgroundColor: tokens.graphite
  },
  uppercase: {
    textTransform: "uppercase"
  },
  metricTile: {
    flex: 1,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: radius.sm,
    backgroundColor: tokens.surface,
    padding: spacing.md
  },
  metricTileDark: {
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(255,255,255,0.06)"
  },
  metricValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.xs
  },
  brandHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  brandMark: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.graphite
  },
  tabBar: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    backgroundColor: "#fbfcfa",
    paddingTop: 10,
    paddingBottom: 22
  },
  tabItem: {
    minWidth: 64,
    alignItems: "center",
    gap: 4
  },
  tabAction: {
    // Fully inside the bar: RN drops touches on children outside the parent's
    // frame, so a button floated above the bar has dead zones. Contained and
    // centered is both tappable everywhere and visually aligned.
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: tokens.electric,
    borderWidth: 1,
    borderColor: tokens.electric,
    ...shadows.card
  },
  tabIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.surfaceMuted
  },
  tabIconActive: {
    backgroundColor: tokens.electric
  }
});
