import React from "react";
import { StyleSheet, View } from "react-native";
import { color, radius } from "../theme";

/**
 * The app's mark: three bars at the heights a voice makes.
 *
 * It replaced a tilted square that stood for a lightning bolt without looking
 * like one. This is the same shape as the button that starts a conversation,
 * which is the honest thing for an assistant you mostly talk to — the mark and
 * the main action share a form, so one teaches the other.
 */
export function AmpMark({
  size = 28,
  tone = color.brand,
}: {
  size?: number;
  /** Overridden on the lock screen, where the mark carries the accent alone. */
  tone?: string;
}) {
  const bar = Math.max(2, Math.round(size * 0.13));
  const heights = [0.42, 1, 0.66];
  return (
    <View style={[styles.row, { height: size, gap: bar * 0.85 }]}>
      {heights.map((scale, i) => (
        <View
          key={i}
          style={{
            width: bar,
            height: size * scale,
            borderRadius: radius.pill,
            backgroundColor: tone,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
});
