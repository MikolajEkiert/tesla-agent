import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space, type } from "../theme";
import type { VehicleState } from "../types";
import { AmpMark } from "./AmpMark";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconMenu } from "./icons";

/** Charge below this reads as a warning rather than a reading. Roughly the
 *  point at which the car itself starts telling you about it. */
const LOW_BATTERY_PERCENT = 20;
const CRITICAL_BATTERY_PERCENT = 10;

/**
 * The charge line.
 *
 * A gauge is the one instrument every car has, and this is the least of it: two
 * points of colour along the top of the app, as wide as the battery is full. It
 * also does the header's separating, which is why there is no rule under the
 * bar — the line between the app and the car's state *is* the car's state.
 *
 * It only animates while charging, and only then because a number that is
 * climbing should not look like one that is sitting still.
 */
function ChargeLine({ percent, charging }: { percent?: number; charging?: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!charging) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [charging, pulse]);

  if (percent == null) return <View style={styles.chargeFallback} />;

  const tone =
    percent <= CRITICAL_BATTERY_PERCENT
      ? color.alert
      : percent <= LOW_BATTERY_PERCENT
      ? color.security
      : color.charge;

  return (
    <View style={styles.chargeTrack}>
      <Animated.View
        style={[
          styles.chargeFill,
          {
            width: `${Math.max(1, Math.min(100, percent))}%`,
            backgroundColor: tone,
            // Held back from full strength unless the charge is low enough to
            // be news. At full brightness a green bar filling from the left is
            // read as a progress bar — something loading, rather than a gauge.
            opacity: Animated.multiply(pulse, percent <= LOW_BATTERY_PERCENT ? 1 : 0.65),
          },
        ]}
      />
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
  const [askDisconnect, setAskDisconnect] = useState(false);
  const awake = state?.awake;
  const staleSeconds = state?.stale_seconds;
  const battery = state?.battery_percent;
  const charging = state?.charging;
  const locked = state?.locked;
  const climateOn = state?.climate_on;
  const target = state?.target_temp_c;

  const formatStaleness = (seconds: number): string => {
    if (seconds < 60) return t("staleJustNow");
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.round(mins / 60)}h`;
  };

  /**
   * Readings are colourless on purpose.
   *
   * They used to each carry a coloured dot, which spent the vehicle palette on
   * things that are merely true — the doors are locked, the cabin is at 21° —
   * and left nothing to distinguish the moments that need a second look. Colour
   * now appears here for one reason only: the charge is low enough to matter.
   */
  const readings: { text: string; tone?: string }[] = [];
  if (awake === false) {
    readings.push({
      text: staleSeconds != null ? `${t("asleep")} · ${formatStaleness(staleSeconds)}` : t("asleep"),
    });
  }
  if (battery != null) {
    readings.push({
      text: charging ? `${Math.round(battery)}% ↑` : `${Math.round(battery)}%`,
      tone:
        battery <= CRITICAL_BATTERY_PERCENT
          ? color.alert
          : battery <= LOW_BATTERY_PERCENT
          ? color.security
          : undefined,
    });
  }
  readings.push({ text: locked === false ? t("unlocked") : t("locked") });
  if (climateOn && target != null) readings.push({ text: `${target}°C` });

  return (
    <View>
      <View style={styles.bar}>
        <View style={styles.leading}>
          {onOpenMenu && (
            <Pressable
              onPress={onOpenMenu}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("menu")}
              style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
            >
              <IconMenu size={18} color={color.textSecondary} />
              {activeActionCount > 0 && <View style={styles.menuBadge} />}
            </Pressable>
          )}
          <Pressable
            onLongPress={onDisconnect ? () => setAskDisconnect(true) : undefined}
            hitSlop={8}
            style={styles.brandGroup}
          >
            <AmpMark size={13} />
            <Text style={styles.brand}>AMP</Text>
          </Pressable>
        </View>

        <View style={styles.readings}>
          {readings.map((reading, index) => (
            <React.Fragment key={index}>
              {index > 0 && <Text style={styles.separator}>·</Text>}
              <Text
                style={[styles.reading, reading.tone ? { color: reading.tone } : null]}
                numberOfLines={1}
              >
                {reading.text}
              </Text>
            </React.Fragment>
          ))}
        </View>
      </View>

      <ChargeLine percent={battery} charging={charging} />

      <ConfirmDialog
        visible={askDisconnect}
        title={t("disconnectTitle")}
        body={t("disconnectBody")}
        confirmLabel={t("disconnectConfirm")}
        cancelLabel={t("disconnectCancel")}
        onConfirm={() => {
          setAskDisconnect(false);
          onDisconnect?.();
        }}
        onCancel={() => setAskDisconnect(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 56,
    backgroundColor: color.bg,
  },
  brandGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  brand: {
    fontFamily: font.displayBold,
    fontSize: 13,
    letterSpacing: 2.5,
    color: color.textPrimary,
  },
  readings: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: space.sm,
  },
  reading: {
    ...type.caption,
    color: color.textTertiary,
    flexShrink: 1,
  },
  separator: {
    ...type.caption,
    color: color.hairline,
  },
  leading: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  menuButton: {
    justifyContent: "center",
    padding: space.xs,
    margin: -space.xs,
    borderRadius: radius.sm,
  },
  menuButtonPressed: {
    backgroundColor: color.surfaceHover,
  },
  menuBadge: {
    // A timer running with the drawer closed would otherwise be invisible.
    position: "absolute",
    top: -1,
    right: -1,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.climate,
  },
  chargeTrack: {
    height: 2,
    backgroundColor: color.hairline,
  },
  chargeFill: {
    height: 2,
  },
  /** Nothing known about the car yet: the line falls back to being a rule. */
  chargeFallback: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
});
