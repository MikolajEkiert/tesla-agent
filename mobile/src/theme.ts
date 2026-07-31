/**
 * Design tokens for Amp.
 *
 * The shell is a modern assistant: one dark canvas, surfaces that separate by
 * value rather than by lines, generous radii, and a single accent for anything
 * you can press. That much it shares with every chat app worth using.
 *
 * What it does not share is where colour is allowed to appear. Amp talks to a
 * car, so colour is reserved for the car: each accent below maps to one real
 * vehicle system, and a coloured mark anywhere in the app always means that
 * system did something. Ambient readings — the ones you glance at rather than
 * act on — are deliberately colourless. That is the whole rule, and the reason
 * the interface stays quiet until the car has something to say.
 */

export const color = {
  // Four steps of one dark, close together. Depth comes from value; hairlines
  // are for structure that is genuinely structural, not for outlining boxes.
  bg: "#0F1114",
  surface: "#16191D",
  surfaceRaised: "#1D2126",
  surfaceHover: "#252A31",
  surfacePressed: "#2C323A",
  hairline: "#282D34",

  // All three tiers clear 4.5:1 against every surface above, because this is
  // read at arm's length, in daylight, by someone who should be looking at the
  // road.
  textPrimary: "#F3F5F7",
  textSecondary: "#AEB7C2",
  textTertiary: "#8A939F",

  /** The app itself: anything you can press, and nothing else. Violet rather
   *  than the old blue, which sat a shade away from the climate accent and
   *  quietly stole its meaning. */
  brand: "#7D7AFF",
  brandDim: "#3F3E80",
  brandSoft: "rgba(125,122,255,0.13)",

  // One accent per vehicle system. A dot in the system rail, the charge line
  // under the header, and a confirmation card all draw from this list, so the
  // colour always answers "which part of the car".
  climate: "#5FB0F2",
  charge: "#45D69A",
  security: "#F0B84E",
  alert: "#F0655C",
  alertSoft: "rgba(240,101,92,0.12)",
} as const;

/**
 * Archivo for anything that names the product — a signage face, which is what
 * a car is covered in. Figtree for everything you read, because it is legible
 * small and at an angle. JetBrains Mono stays the machine's own voice: tool
 * calls, readings, timers. Three voices, one each for the brand, the person,
 * and the car.
 */
export const font = {
  display: "Archivo_600SemiBold",
  displayBold: "Archivo_700Bold",
  body: "Figtree_400Regular",
  bodyMedium: "Figtree_500Medium",
  bodySemiBold: "Figtree_600SemiBold",
  mono: "JetBrainsMono_500Medium",
  monoBold: "JetBrainsMono_700Bold",
} as const;

/** Named sizes, so a heading is chosen rather than typed. */
export const type = {
  hero: { fontFamily: font.display, fontSize: 30, lineHeight: 37, letterSpacing: -0.6 },
  title: { fontFamily: font.display, fontSize: 20, lineHeight: 26, letterSpacing: -0.3 },
  body: { fontFamily: font.body, fontSize: 16, lineHeight: 24 },
  bodyStrong: { fontFamily: font.bodySemiBold, fontSize: 16, lineHeight: 24 },
  label: { fontFamily: font.bodyMedium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: font.mono, fontSize: 11, lineHeight: 16, letterSpacing: 0.4 },
  eyebrow: {
    fontFamily: font.monoBold,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.6,
    textTransform: "uppercase" as const,
  },
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const motion = {
  fast: 140,
  base: 220,
  slow: 320,
} as const;

/** The chat stops widening here. Past it a sentence is measured in eye
 *  movements rather than characters. */
export const READING_WIDTH = 760;

/** Below this the drawer is something you pull in; above it there is room for
 *  it to simply be there. */
export const WIDE_LAYOUT = 900;
