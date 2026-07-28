import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { color, font, radius, space } from "../theme";
import type { Role } from "../types";

/**
 * User turns read as a plain pill (something you typed); assistant turns
 * read as plain text with no bubble chrome — closer to a HUD readout than a
 * messenger, which fits "spoken to you" better than a chat cliche does.
 */
export function MessageRow({ role, text }: { role: Role; text: string }) {
  if (role === "user") {
    return (
      <View style={styles.userRow}>
        <View style={styles.userPill}>
          <Text style={styles.userText}>{text}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantRow}>
      <Text style={styles.assistantText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: {
    alignItems: "flex-end",
    marginVertical: space.xs,
  },
  userPill: {
    maxWidth: "82%",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    borderTopRightRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  userText: {
    fontFamily: font.bodyMedium,
    fontSize: 16,
    lineHeight: 22,
    color: color.textPrimary,
  },
  assistantRow: {
    alignItems: "flex-start",
    marginVertical: space.sm,
    paddingHorizontal: space.xs,
  },
  assistantText: {
    maxWidth: "90%",
    fontFamily: font.body,
    fontSize: 16,
    lineHeight: 23,
    color: color.textPrimary,
  },
});
