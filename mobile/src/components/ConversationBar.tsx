import React from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space } from "../theme";

export type ConversationPhase = "listening" | "thinking" | "speaking";

/**
 * The entry point: a small button beside the hold-to-talk mic that starts a
 * continuous back-and-forth instead of one question.
 *
 * Kept separate from VoiceButton rather than folded into it (e.g. "tap this
 * one to start a conversation, hold it for one question") because overloading
 * a control that already ships is how existing muscle memory gets a new,
 * unannounced side effect. A second, distinctly-shaped button costs a little
 * width and risks nothing.
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
      hitSlop={10}
      accessibilityLabel={t("conversationStart")}
      style={[styles.entryButton, disabled && styles.entryButtonDisabled]}
    >
      <View style={styles.entryGlyph}>
        <View style={[styles.entryBar, { height: 6 }]} />
        <View style={[styles.entryBar, { height: 12 }]} />
        <View style={[styles.entryBar, { height: 9 }]} />
      </View>
    </Pressable>
  );
}

/**
 * Replaces the whole input bar while a conversation is running.
 *
 * One tap means something different depending on phase, and that is
 * deliberate rather than three separate controls: while listening it ends
 * your turn early (you don't have to wait out the silence timer if you're
 * done), while the assistant is speaking it interrupts — the closest this
 * architecture gets to talking over it, since there is no cheap way to tell
 * "the driver started talking" from "the car's own speaker leaked back into
 * the microphone" without echo cancellation this app doesn't have. Tapping
 * mid-"thinking" does nothing; there is nothing yet to cut off.
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
  const label =
    phase === "listening"
      ? t("conversationListening")
      : phase === "thinking"
      ? t("conversationThinking")
      : t("conversationSpeaking");

  // Peaks rarely reach 1.0 in normal speech, so the ring is scaled to the part
  // of the range a voice actually occupies — same curve as VoiceButton, kept
  // consistent so the two don't feel like different products.
  const ring = phase === "listening" ? 1 + Math.min(level * 2.5, 1) * 0.5 : 1;

  return (
    <View style={styles.wrap}>
      <Pressable onPress={onTap} style={styles.bar}>
        <View style={styles.statusRow}>
          {phase === "listening" && (
            <View style={[styles.ring, { transform: [{ scale: ring }] }]} pointerEvents="none" />
          )}
          <View style={[styles.dot, phase === "speaking" && styles.dotSpeaking]} />
          <Text style={styles.label}>{label}</Text>
        </View>
      </Pressable>
      <Pressable
        onPress={onEnd}
        hitSlop={10}
        accessibilityLabel={t("conversationEnd")}
        style={styles.endButton}
      >
        <Text style={styles.endGlyph}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  entryButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
    ...(Platform.OS === "web"
      ? ({ userSelect: "none", WebkitTouchCallout: "none" } as object)
      : {}),
  },
  entryButtonDisabled: {
    opacity: 0.5,
  },
  entryGlyph: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2.5,
    height: 14,
  },
  entryBar: {
    width: 2.5,
    borderRadius: 1.5,
    backgroundColor: color.textSecondary,
  },
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  bar: {
    flex: 1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.brand,
    backgroundColor: color.surfaceRaised,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  ring: {
    position: "absolute",
    left: -2,
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
    opacity: 0.3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
  },
  dotSpeaking: {
    backgroundColor: color.climate,
  },
  label: {
    fontFamily: font.bodySemiBold,
    fontSize: 14,
    color: color.textPrimary,
  },
  endButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
    justifyContent: "center",
  },
  endGlyph: {
    fontSize: 15,
    color: color.textSecondary,
    fontFamily: font.bodySemiBold,
  },
});
