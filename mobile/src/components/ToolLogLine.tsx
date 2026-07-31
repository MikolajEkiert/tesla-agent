import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, space, type } from "../theme";
import { describeTool } from "../toolMeta";
import type { ToolCall } from "../types";
import { RAIL_GUTTER, railStyles } from "./rail";

/**
 * One thing the assistant did to the car, on the system rail.
 *
 * These used to be little grey pills floating in the transcript, which read as
 * chrome — something the app was doing, rather than something the car was. Now
 * they hang off a hairline that runs down into the reply below them, so a turn
 * reads as one event: these systems were touched, and this is what came of it.
 * The dot is the only colour, and it says which system.
 */
export function ToolLogLine({ call }: { call: ToolCall }) {
  const { system, dot, text } = describeTool(call.tool, call.input, call.ok);
  return (
    <View style={styles.row}>
      <View style={railStyles.gutter}>
        <View style={railStyles.line} />
        <View style={[styles.dot, { backgroundColor: dot }]} />
      </View>
      <View style={styles.body}>
        <Text style={styles.system}>{system}</Text>
        <Text style={styles.text} numberOfLines={2}>
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingVertical: 3,
  },
  dot: {
    position: "absolute",
    // Centred on the rail, and on the cap height of the label beside it.
    left: RAIL_GUTTER / 2 - 4,
    top: 5,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: color.bg,
  },
  body: {
    flex: 1,
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.sm,
    paddingVertical: 1,
  },
  system: {
    ...type.eyebrow,
    color: color.textSecondary,
  },
  text: {
    ...type.caption,
    color: color.textTertiary,
    flexShrink: 1,
  },
});
