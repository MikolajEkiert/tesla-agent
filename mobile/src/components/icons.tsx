import React from "react";
import { StyleSheet, View } from "react-native";
import { color as palette } from "../theme";

/**
 * The app's glyphs, drawn rather than typed.
 *
 * They used to be characters — ☰ ✕ ＋ ⚙ ⏻ ↑ — which is fine until you look at
 * them on a second device. `＋` is the fullwidth plus and sits noticeably
 * larger than everything beside it; `⏻` is missing from enough fonts that a
 * phone can fall back to a box; and all of them scale with the text size the
 * owner chose in system settings rather than with the control they sit in, so
 * a 44-point button could end up holding a 30-point glyph.
 *
 * Views instead. No icon dependency, no font to load, and identical geometry
 * everywhere. Each takes a `size` (the box it draws inside) and a `color`;
 * `background` is only needed by the two glyphs that mask part of themselves.
 */

interface IconProps {
  size?: number;
  color?: string;
  /** The surface the icon sits on — used where a shape has to be cut out of
   *  another, since there is no masking primitive here. */
  background?: string;
}

const BAR = 1.6;

export function IconMenu({ size = 18, color = palette.textSecondary }: IconProps) {
  return (
    <View style={{ width: size, height: size, justifyContent: "center", gap: size * 0.22 }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ height: BAR, borderRadius: BAR, backgroundColor: color }} />
      ))}
    </View>
  );
}

export function IconClose({ size = 16, color = palette.textSecondary }: IconProps) {
  const bar = {
    position: "absolute" as const,
    width: size * 0.86,
    height: BAR,
    borderRadius: BAR,
    backgroundColor: color,
  };
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View style={[bar, { transform: [{ rotate: "45deg" }] }]} />
      <View style={[bar, { transform: [{ rotate: "-45deg" }] }]} />
    </View>
  );
}

export function IconPlus({ size = 16, color = palette.brand }: IconProps) {
  const bar = {
    position: "absolute" as const,
    width: size,
    height: BAR,
    borderRadius: BAR,
    backgroundColor: color,
  };
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View style={bar} />
      <View style={[bar, { transform: [{ rotate: "90deg" }] }]} />
    </View>
  );
}

/** Send. A triangle rather than a rotated-bar chevron: borders give a crisp
 *  point at any size, where two hairlines meeting at 45° do not. */
export function IconArrowUp({ size = 16, color = palette.bg }: IconProps) {
  const head = size * 0.34;
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: head,
          borderRightWidth: head,
          borderBottomWidth: head,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderBottomColor: color,
        }}
      />
      <View
        style={{
          width: BAR * 1.4,
          height: size * 0.4,
          borderRadius: BAR,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

export function IconChevronDown({ size = 16, color = palette.textSecondary }: IconProps) {
  const head = size * 0.32;
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: head,
          borderRightWidth: head,
          borderTopWidth: head,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderTopColor: color,
        }}
      />
    </View>
  );
}

/** Settings, as two sliders. A gear needs teeth to read as one, and teeth at
 *  15 points are mush; a slider says "adjust" at any size. */
export function IconSliders({
  size = 16,
  color = palette.textSecondary,
  background = palette.surface,
}: IconProps) {
  const knob = size * 0.34;
  const row = (knobLeft: number, key: number) => (
    <View key={key} style={{ height: knob, justifyContent: "center" }}>
      <View style={{ height: BAR, borderRadius: BAR, backgroundColor: color }} />
      <View
        style={{
          position: "absolute",
          left: knobLeft,
          width: knob,
          height: knob,
          borderRadius: knob,
          borderWidth: 1.5,
          borderColor: color,
          backgroundColor: background,
        }}
      />
    </View>
  );
  return (
    <View style={{ width: size, height: size, justifyContent: "center", gap: size * 0.18 }}>
      {[size * 0.14, size * 0.52].map((left, i) => row(left, i))}
    </View>
  );
}

/** Lock the app: the power symbol — a ring broken at the top by a stem. The
 *  break is painted, not cut, which is why this one needs the background. */
export function IconPower({
  size = 16,
  color = palette.textSecondary,
  background = palette.surface,
}: IconProps) {
  const ring = size * 0.82;
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring,
          borderWidth: 1.6,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: (size - ring) / 2 - 1,
          width: size * 0.26,
          height: size * 0.24,
          backgroundColor: background,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: (size - ring) / 2 - 1,
          width: BAR,
          height: size * 0.42,
          borderRadius: BAR,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** Deleting a chat is not the same gesture as closing something, so it stopped
 *  borrowing the ✕ that closes things. */
export function IconTrash({ size = 16, color = palette.textTertiary }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: "center", paddingTop: size * 0.12 }}>
      <View
        style={{
          width: size * 0.34,
          height: size * 0.12,
          borderTopLeftRadius: 1,
          borderTopRightRadius: 1,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.86,
          height: BAR,
          borderRadius: BAR,
          marginTop: 1,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          width: size * 0.62,
          height: size * 0.56,
          marginTop: 1,
          borderWidth: 1.4,
          borderTopWidth: 0,
          borderColor: color,
          borderBottomLeftRadius: 2,
          borderBottomRightRadius: 2,
        }}
      />
    </View>
  );
}

/** Copy: the top sheet lifted off the one beneath it. */
export function IconCopy({ size = 15, color = palette.textSecondary }: IconProps) {
  const sheet = size * 0.62;
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: sheet,
          height: sheet,
          borderRadius: 3,
          borderWidth: 1.4,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: 0,
          bottom: 0,
          width: sheet,
          height: sheet,
          borderRadius: 3,
          borderWidth: 1.4,
          borderColor: color,
          backgroundColor: palette.surfaceRaised,
        }}
      />
    </View>
  );
}

/** Read it aloud: a cone, and the sound leaving it. The waves are half-rings —
 *  a bordered circle with its left half clipped away, which is the closest
 *  thing to an arc available without a drawing library. */
export function IconSpeak({ size = 15, color = palette.textSecondary }: IconProps) {
  const wave = (scale: number, key: number) => {
    const d = size * scale;
    return (
      <View key={key} style={{ width: d / 2, height: d, overflow: "hidden" }}>
        <View
          style={{
            width: d,
            height: d,
            borderRadius: d,
            borderWidth: 1.4,
            borderColor: color,
            marginLeft: -d / 2,
          }}
        />
      </View>
    );
  };
  return (
    <View style={[styles.center, { width: size, height: size, flexDirection: "row", gap: 1 }]}>
      <View
        style={{
          width: 0,
          height: 0,
          borderTopWidth: size * 0.3,
          borderBottomWidth: size * 0.3,
          borderRightWidth: size * 0.28,
          borderTopColor: "transparent",
          borderBottomColor: "transparent",
          borderRightColor: color,
        }}
      />
      {wave(0.5, 0)}
      {wave(0.86, 1)}
    </View>
  );
}

/** Send it again: a ring open at the top, with the arrowhead that closes it. */
export function IconRetry({ size = 15, color = palette.textSecondary }: IconProps) {
  const ring = size * 0.84;
  const head = size * 0.2;
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring,
          borderWidth: 1.5,
          borderColor: color,
          borderTopColor: "transparent",
          transform: [{ rotate: "45deg" }],
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 0,
          right: size * 0.1,
          width: 0,
          height: 0,
          borderLeftWidth: head,
          borderRightWidth: head,
          borderBottomWidth: head * 1.1,
          borderLeftColor: "transparent",
          borderRightColor: "transparent",
          borderBottomColor: color,
        }}
      />
    </View>
  );
}

/** Rename: a nib on a shaft, at the angle a hand holds one. */
export function IconPencil({ size = 15, color = palette.textTertiary }: IconProps) {
  return (
    <View style={[styles.center, { width: size, height: size }]}>
      <View style={{ transform: [{ rotate: "45deg" }], alignItems: "center" }}>
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: size * 0.11,
            borderRightWidth: size * 0.11,
            borderBottomWidth: size * 0.26,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderBottomColor: color,
          }}
        />
        <View style={{ width: size * 0.22, height: size * 0.46, backgroundColor: color }} />
        {/* The ferrule: a gap and a cap, which is what stops the shaft reading
            as a plain rounded bar at fourteen points. */}
        <View style={{ height: 1.5 }} />
        <View
          style={{
            width: size * 0.22,
            height: size * 0.14,
            borderRadius: 1,
            backgroundColor: color,
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
});
