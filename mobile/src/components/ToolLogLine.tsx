import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, font, space } from "../theme";
import { describeTool } from "../toolMeta";
import type { ToolCall } from "../types";

/**
 * Renders one tool call as an instrument-log entry — the app's signature
 * device: the chat surfaces the car's own event log reacting in real time,
 * not hidden system chrome.
 */
export function ToolLogLine({ call }: { call: ToolCall }) {
  const { system, dot, text } = describeTool(call.tool, call.input, call.ok);
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={styles.system}>{system}</Text>
      <Text style={styles.arrow}>·</Text>
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingVertical: 3,
    paddingHorizontal: space.md,
    marginVertical: 2,
    alignSelf: "flex-start",
    backgroundColor: color.surface,
    borderRadius: 6,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginRight: 2,
  },
  system: {
    fontFamily: font.mono,
    fontSize: 11,
    letterSpacing: 1,
    color: color.textSecondary,
  },
  arrow: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.textTertiary,
  },
  text: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.textTertiary,
  },
});
