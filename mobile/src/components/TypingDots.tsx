import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { color, radius, space } from "../theme";
import { RAIL_GUTTER } from "./rail";

/**
 * Working on it.
 *
 * A single dot at the head of the system rail, breathing — the same position
 * and size a real tool call will occupy a second later, so the answer grows out
 * of the waiting rather than replacing it. Three bouncing dots said "typing",
 * which is not what is happening: the car is being asked something.
 */
export function TypingDots() {
  const pulse = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.row}>
      <Animated.View style={[styles.dot, { opacity: pulse }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    width: RAIL_GUTTER,
    alignItems: "center",
    paddingVertical: space.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
  },
});
