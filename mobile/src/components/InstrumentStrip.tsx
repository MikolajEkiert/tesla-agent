import React from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { color, font, space } from "../theme";
import type { VehicleState } from "../types";

function Reading({ dot, label }: { dot: string; label: string }) {
  return (
    <View style={styles.reading}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text style={styles.readingText}>{label}</Text>
    </View>
  );
}

export function InstrumentStrip({
  state,
  onDisconnect,
}: {
  state: VehicleState | null;
  /** Omit to hide the disconnect affordance entirely (e.g. on the mock adapter). */
  onDisconnect?: () => void;
}) {
  const battery = state?.battery_percent;
  const locked = state?.locked;
  const climateOn = state?.climate_on;
  const target = state?.target_temp_c;

  const handleLongPress = () => {
    if (!onDisconnect) return;
    Alert.alert("Disconnect Tesla account?", "You'll need to reconnect to control the car again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: onDisconnect },
    ]);
  };

  return (
    <View style={styles.container}>
      <Pressable onLongPress={handleLongPress} hitSlop={8}>
        <Text style={styles.brand}>AMP</Text>
      </Pressable>
      <View style={styles.readings}>
        {battery != null && (
          <Reading dot={color.charge} label={`${Math.round(battery)}%`} />
        )}
        <Reading dot={color.security} label={locked === false ? "unlocked" : "locked"} />
        {climateOn && target != null && (
          <Reading dot={color.climate} label={`${target}°C`} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  brand: {
    fontFamily: font.displayBold,
    fontSize: 13,
    letterSpacing: 3,
    color: color.textPrimary,
  },
  readings: {
    flexDirection: "row",
    gap: space.lg,
  },
  reading: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  readingText: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.textSecondary,
    letterSpacing: 0.3,
  },
});
