import React from "react";
import { View } from "react-native";
import { color } from "../theme";

/**
 * The mark: a bolt, drawn as two tapered strokes meeting at a waist.
 *
 * Amp means two things at once and both are this product — ampere, because the
 * car runs on it, and amplitude, because you talk to it. The bolt carries the
 * half a shape can carry.
 *
 * What it replaced was a tilted block, which said nothing, and before that the
 * three bars of a voice level, which said what the conversation button was
 * already saying. A mark and a control drawn alike leave neither meaning
 * anything on its own, so the bars stay on the button.
 *
 * Drawn rather than fetched, like every glyph in components/icons.tsx: this app
 * has no SVG runtime and one shape is not a reason to add one. Two attempts got
 * as far as the header before this one: a pair of constant-width slabs, which
 * at 13 points merged into a single leaning bar with no kink in it at all, and
 * the same slabs pushed apart, which read as two marks rather than one. What
 * makes a bolt a bolt is the taper — each stroke narrowing towards the point it
 * hands over at — so each is a triangle rather than a bar.
 *
 * Triangles, on a platform with no polygons, are the CSS border trick: a
 * zero-sized box whose bottom border is a wedge between two transparent sides.
 * That gives an upward wedge whose apex sits *within* its base; this bolt's
 * apex leans well past it, so each wedge is skewed by exactly the amount that
 * carries the apex from where the trick can put it to where the drawing wants
 * it. The numbers below are the drawn shape's own vertices, and the skew is
 * derived from them rather than guessed — see `wedge`.
 *
 * The bolt is point-symmetric about its centre, so the second stroke is the
 * first turned half a turn. One set of coordinates, and the two halves cannot
 * drift apart. scripts/gen_icons.py draws the same six vertices as one polygon,
 * where Pillow can do polygons.
 */

/**
 * The upper stroke's three corners, as fractions of the mark. The lower one is
 * these turned 180° about (0.5, 0.5).
 *
 * The point and the outer corner are the drawn bolt's own; the inner corner is
 * carried past the centre line, and that is the one deliberate departure. Two
 * wedges that merely touch at the waist render as two shards with a nick
 * between them — measured on screen against the drawing, at 130px and at 13.
 * Overlapping them fills the middle, which is what makes the mark read as one
 * continuous stroke with a kink in it, the way the drawing does. The overlap is
 * invisible: it is the same colour on both sides of the seam.
 */
const APEX = { x: 0.608, y: 0.104 };
const BASE_LEFT = { x: 0.242, y: 0.575 };
const BASE_RIGHT = { x: 0.56, y: 0.575 };

/**
 * The border-trick wedge, solved for a leaning apex.
 *
 * The trick draws a triangle with its apex at `borderLeftWidth` along a base
 * of `borderLeftWidth + borderRightWidth`, so the apex can only sit above its
 * own base. Skewing moves points by their distance from the box's centre, and
 * that is the free variable: put the apex halfway along the base, then skew by
 * whatever carries it out to where it belongs. The base keeps its width under
 * a skew, so only the left edge has to be walked back.
 */
function wedge(size: number) {
  const width = BASE_RIGHT.x - BASE_LEFT.x;
  const height = BASE_LEFT.y - APEX.y;
  // How far past its base-left corner the apex actually sits.
  const reach = APEX.x - BASE_LEFT.x;
  // Apex parked mid-base before the skew, so both border widths stay positive
  // at any size.
  const skew = (width / 2 - reach) / height;
  return {
    left: (BASE_LEFT.x - (height * skew) / 2) * size,
    top: APEX.y * size,
    borderLeftWidth: (width / 2) * size,
    borderRightWidth: (width / 2) * size,
    borderBottomWidth: height * size,
    skewDeg: `${(Math.atan(skew) * 180) / Math.PI}deg`,
    // Where the same box goes for the half-turned copy: its own bounding box,
    // mirrored through the centre of the mark.
    mirrorLeft: (1 - (BASE_LEFT.x - (height * skew) / 2) - width) * size,
    mirrorTop: (1 - BASE_LEFT.y) * size,
  };
}

export function AmpMark({
  size = 40,
  tone = color.brand,
}: {
  size?: number;
  /** Anything but the brand violet is a deliberate exception — the monochrome
   *  Android layer, and a mark drawn on a coloured surface. */
  tone?: string;
}) {
  const w = wedge(size);
  const stroke = {
    position: "absolute" as const,
    width: 0,
    height: 0,
    borderLeftWidth: w.borderLeftWidth,
    borderRightWidth: w.borderRightWidth,
    borderBottomWidth: w.borderBottomWidth,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: tone,
    // Only the bottom border paints, but leaving the others' style unset makes
    // some engines skip the box entirely.
    borderStyle: "solid" as const,
  };

  return (
    <View style={{ width: size, height: size }}>
      <View style={[stroke, { left: w.left, top: w.top, transform: [{ skewX: w.skewDeg }] }]} />
      <View
        style={[
          stroke,
          {
            left: w.mirrorLeft,
            top: w.mirrorTop,
            // A half turn commutes with the skew, so the order of these two
            // does not matter — which is worth knowing before someone
            // reorders them.
            transform: [{ skewX: w.skewDeg }, { rotate: "180deg" }],
          },
        ]}
      />
    </View>
  );
}
