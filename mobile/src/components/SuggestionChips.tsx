import React, { useEffect, useRef } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useLanguage } from "../LanguageContext";
import type { TranslationKey } from "../i18n";
import { color, motion, radius, space, type } from "../theme";

/**
 * Six things worth asking, on an empty chat.
 *
 * Not a menu of features — the assistant takes anything you can say. Four are
 * the ones that get asked in a car park in the rain, when typing is the last
 * thing anyone wants to do. The other two are here because an empty chat
 * offering nothing but vehicle commands answers "what is this for?" on its
 * own, and answers it wrongly: the owner's complaint was that he could never
 * just talk to the assistant, and a first screen made of four car commands
 * teaches exactly that. Each chip sends exactly the sentence it shows, so
 * tapping teaches you what you could have said — which is why two of them say
 * something that has nothing to do with the car.
 */
const SUGGESTIONS: TranslationKey[] = [
  "chipWarm",
  "chipRange",
  "chipDinner",
  "chipCharger",
  "chipLock",
  "chipJoke",
];

/** Each chip arrives just after the one before it. Short enough that the row
 *  reads as one gesture rather than four events. */
const STAGGER_MS = 45;

function Chip({ label, index, onPress }: { label: string; index: number; onPress: () => void }) {
  const enter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      // Asked for less movement: the chips are simply there, at once.
      if (reduce) {
        enter.setValue(1);
        return;
      }
      Animated.timing(enter, {
        toValue: 1,
        duration: motion.base,
        delay: index * STAGGER_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    return () => {
      cancelled = true;
    };
  }, [enter, index]);

  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
        ],
      }}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      >
        <Text style={styles.chipText}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export function SuggestionChips({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useLanguage();
  return (
    <View style={styles.row}>
      {SUGGESTIONS.map((key, index) => {
        const label = t(key);
        return <Chip key={key} label={label} index={index} onPress={() => onPick(label)} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    marginTop: space.xl,
  },
  chip: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  chipPressed: {
    backgroundColor: color.surfaceHover,
  },
  chipText: {
    ...type.label,
    fontSize: 14,
    color: color.textSecondary,
  },
});
