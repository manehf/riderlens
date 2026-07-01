import type { TextStyle } from "react-native";

export const designTokensCss = `:root {
  /* Surfaces */
  --background: #f5f7f1;
  --surface: #ffffff;
  --surface-muted: #edf2ea;
  --graphite: #111613; /* dark analysis/scan surface */
  --graphite-2: #171d19;

  /* Text */
  --text: #101411;
  --text-muted: #60685f;
  --border: #dde3da;

  /* Accents */
  --electric: #b6ff2e; /* brand + primary action; dark surfaces / solid blocks only */
  --electric-soft: #efffd8;
  --green: #2e7d32; /* saved/current; thin fills + progress on light surfaces */
  --cyan: #00b8d9; /* measured / pose lines / analysis */
  --cyan-soft: #d9f8ff;
  --amber: #e19a00; /* uncertainty / caution */
  --amber-soft: #fff0ce;
  --red: #d64545; /* error / destructive / serious warning */
  --red-soft: #ffe0df;

  /* Type */
  --font-ui: "IBM Plex Sans";
  --font-mono: "IBM Plex Mono";
}`;

export const tokens = {
  background: "#f5f7f1",
  surface: "#ffffff",
  surfaceMuted: "#edf2ea",
  graphite: "#111613",
  graphite2: "#171d19",
  text: "#101411",
  textMuted: "#60685f",
  border: "#dde3da",
  electric: "#b6ff2e",
  electricSoft: "#efffd8",
  green: "#2e7d32",
  cyan: "#00b8d9",
  cyanSoft: "#d9f8ff",
  amber: "#e19a00",
  amberSoft: "#fff0ce",
  red: "#d64545",
  redSoft: "#ffe0df",
  fontUi: "IBMPlexSans",
  fontUiSemiBold: "IBMPlexSans-SemiBold",
  fontUiBold: "IBMPlexSans-Bold",
  fontMono: "IBMPlexMono-Medium",
  fontMonoBold: "IBMPlexMono-Bold"
} as const;

export const radius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 14,
  pill: 999
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32
} as const;

export const shadows = {
  card: {
    shadowColor: tokens.text,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 4
  }
} as const;

export const numericText: TextStyle = {
  fontFamily: tokens.fontMono,
  fontVariant: ["tabular-nums"]
};

export const numericTextBold: TextStyle = {
  fontFamily: tokens.fontMonoBold,
  fontVariant: ["tabular-nums"]
};
