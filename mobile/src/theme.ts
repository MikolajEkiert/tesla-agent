/**
 * Design tokens for Amp — an instrument-cluster read on a chat UI, not a
 * generic messenger. The car is dark inside; the palette follows that, and
 * function colors map to real vehicle systems rather than one brand accent.
 */

export const color = {
  bg: "#0C0E12",
  surface: "#16191F",
  surfaceRaised: "#1D2129",
  hairline: "#242832",

  textPrimary: "#ECEEF1",
  textSecondary: "#8B93A1",
  textTertiary: "#565D68",

  // Product identity — reserved for the app itself, never vehicle state.
  brand: "#6F8CFF",
  brandDim: "#3D4A8F",

  // Function-coded accents — each maps to one real vehicle system. A colored
  // dot in the log always means the same thing everywhere in the app.
  climate: "#57A6E8",
  charge: "#4FD897",
  security: "#E8B54F",
  alert: "#E2564F",
} as const;

export const font = {
  display: "SpaceGrotesk_600SemiBold",
  displayBold: "SpaceGrotesk_700Bold",
  body: "Manrope_400Regular",
  bodyMedium: "Manrope_500Medium",
  bodySemiBold: "Manrope_600SemiBold",
  mono: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
} as const;
