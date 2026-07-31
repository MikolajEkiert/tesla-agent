import React from "react";
import { View } from "react-native";
import { color } from "../theme";

/**
 * The mark: a tilted block in the brand colour.
 *
 * Briefly replaced by three bars at the heights a voice makes, on the argument
 * that an assistant you talk to should wear its microphone. The bolt is what
 * the owner wants, and it is the better call anyway — the bars were the
 * conversation button's glyph, so the mark and a control were saying the same
 * thing in the same shape, and neither got to mean anything on its own.
 *
 * Kept as a component rather than a style so the tilt, the radius and the
 * colour stay identical everywhere it appears — at 15 points beside the
 * wordmark and at 40 on the lock screen.
 */
export function AmpMark({
  size = 40,
  tone = color.brand,
}: {
  size?: number;
  tone?: string;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        backgroundColor: tone,
        // Scaled with the mark: a fixed radius turns a 15-point block into a
        // circle and leaves a 40-point one looking square.
        borderRadius: Math.max(2, size * 0.2),
        transform: [{ rotate: "12deg" }],
      }}
    />
  );
}
