import React, { useEffect, useRef } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useLanguage } from "../LanguageContext";
import { color, radius, space, type } from "../theme";
import { IconClose } from "./icons";

export type ConversationPhase = "listening" | "thinking" | "speaking";

/**
 * Opens a continuous back-and-forth, as opposed to the microphone beside it,
 * which takes one question while you hold it.
 *
 * Kept as its own button rather than folded into the microphone: overloading a
 * control that already ships is how existing muscle memory gets a new,
 * unannounced side effect. Three bars at the heights a voice makes, which is
 * this control's own shape and nothing else's.
 */
export function ConversationButton({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t("conversationStart")}
      style={({ pressed }) => [
        styles.entryButton,
        disabled && styles.entryButtonDisabled,
        pressed && styles.entryButtonPressed,
      ]}
    >
      <View style={styles.entryGlyph}>
        <View style={[styles.entryBar, { height: 7 }]} />
        <View style={[styles.entryBar, { height: 14 }]} />
        <View style={[styles.entryBar, { height: 10 }]} />
      </View>
    </Pressable>
  );
}

/**
 * Replaces the whole composer while a conversation is running.
 *
 * One tap means something different depending on phase, deliberately rather
 * than as three separate controls: listening, it ends your turn early; speaking,
 * it interrupts. Mid-thought there is nothing yet to cut off, so it does
 * nothing. The ring is the microphone level — the only honest way to show that
 * the app can hear you.
 */
export function ConversationBar({
  phase,
  level,
  onTap,
  onEnd,
}: {
  phase: ConversationPhase;
  /** 0..1, only meaningful while listening. */
  level: number;
  onTap: () => void;
  onEnd: () => void;
}) {
  const { t } = useLanguage();
  const think = useRef(new Animated.Value(0.35)).current;

  // Thinking has no level to show, so the dot breathes instead of sitting dead.
  useEffect(() => {
    if (phase !== "thinking") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(think, {
          toValue: 1,
          duration: 620,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(think, {
          toValue: 0.35,
          duration: 620,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [phase, think]);

  const label =
    phase === "listening"
      ? t("conversationListening")
      : phase === "thinking"
      ? t("conversationThinking")
      : t("conversationSpeaking");

  // Peaks rarely reach 1.0 in normal speech, so the ring is scaled to the part
  // of the range a voice actually occupies.
  const ring = phase === "listening" ? 1 + Math.min(level * 2.5, 1) * 0.9 : 1;
  const tone = phase === "speaking" ? color.climate : color.brand;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onTap}
        accessibilityRole="button"
        style={({ pressed }) => [styles.bar, pressed && styles.barPressed]}
      >
        <View style={styles.statusRow}>
          <View style={styles.dotBox}>
            {phase === "listening" && (
              <View
                style={[styles.ring, { transform: [{ scale: ring }], backgroundColor: tone }]}
                pointerEvents="none"
              />
            )}
            <Animated.View
              style={[
                styles.dot,
                { backgroundColor: tone },
                phase === "thinking" && { opacity: think },
              ]}
            />
          </View>
          <Text style={styles.label}>{label}</Text>
        </View>
      </Pressable>
      <Pressable
        onPress={onEnd}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t("conversationEnd")}
        style={({ pressed }) => [styles.endButton, pressed && styles.endButtonPressed]}
      >
        <IconClose size={15} color={color.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  entryButton: {
    // 44, not 40: hitSlop covers native, but its web support is inconsistent
    // and the web is where this ships, so the box itself has to be the right
    // size. Sized down during the redesign for the look of the row, which is
    // the wrong thing to trade for in a car.
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceHover,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web"
      ? ({ userSelect: "none", WebkitTouchCallout: "none" } as object)
      : {}),
  },
  entryButtonDisabled: {
    opacity: 0.5,
  },
  entryButtonPressed: {
    backgroundColor: color.surfacePressed,
  },
  entryGlyph: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2.5,
    height: 16,
  },
  entryBar: {
    width: 2.5,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
  },
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  bar: {
    flex: 1,
    borderRadius: radius.xl,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.brand,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
  },
  barPressed: {
    backgroundColor: color.surfaceHover,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  dotBox: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    opacity: 0.28,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  label: {
    ...type.bodyStrong,
    fontSize: 15,
    color: color.textPrimary,
  },
  endButton: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  endButtonPressed: {
    backgroundColor: color.surfaceHover,
  },
});
