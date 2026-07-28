import React from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useLanguage } from "../LanguageContext";
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
  onOpenMenu,
  activeActionCount = 0,
}: {
  state: VehicleState | null;
  /** Omit to hide the disconnect affordance entirely (e.g. on the mock adapter). */
  onDisconnect?: () => void;
  onOpenMenu?: () => void;
  /** Scheduled/running actions — surfaced as a badge so timers aren't invisible. */
  activeActionCount?: number;
}) {
  const { t } = useLanguage();
  const awake = state?.awake;
  const staleSeconds = state?.stale_seconds;
  const battery = state?.battery_percent;
  const locked = state?.locked;
  const climateOn = state?.climate_on;
  const target = state?.target_temp_c;

  const formatStaleness = (seconds: number): string => {
    if (seconds < 60) return t("staleJustNow");
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.round(mins / 60)}h`;
  };

  const handleLongPress = () => {
    if (!onDisconnect) return;
    Alert.alert(t("disconnectTitle"), t("disconnectBody"), [
      { text: t("disconnectCancel"), style: "cancel" },
      { text: t("disconnectConfirm"), style: "destructive", onPress: onDisconnect },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.leading}>
        {onOpenMenu && (
          <Pressable
            onPress={onOpenMenu}
            hitSlop={10}
            accessibilityLabel={t("menu")}
            style={styles.menuButton}
          >
            <Text style={styles.menuGlyph}>☰</Text>
            {activeActionCount > 0 && <View style={styles.menuBadge} />}
          </Pressable>
        )}
        <Pressable onLongPress={handleLongPress} hitSlop={8}>
          <Text style={styles.brand}>AMP</Text>
        </Pressable>
      </View>
      <View style={styles.readings}>
        {awake === false && (
          <Reading
            dot={color.textTertiary}
            label={
              staleSeconds != null ? `${t("asleep")} · ${formatStaleness(staleSeconds)}` : t("asleep")
            }
          />
        )}
        {battery != null && (
          <Reading dot={color.charge} label={`${Math.round(battery)}%`} />
        )}
        <Reading dot={color.security} label={locked === false ? t("unlocked") : t("locked")} />
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
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  menuButton: {
    justifyContent: "center",
  },
  menuGlyph: {
    fontSize: 16,
    color: color.textSecondary,
  },
  menuBadge: {
    // A timer running with the drawer closed would otherwise be invisible.
    position: "absolute",
    top: -2,
    right: -4,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.climate,
  },
});
