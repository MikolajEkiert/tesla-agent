import React from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { parseBlocks, type Span } from "../markdown";
import { color, font, space } from "../theme";

/**
 * An assistant reply, with its formatting rendered rather than displayed.
 *
 * Only assistant turns go through here. What the owner typed is shown exactly
 * as typed — if they write two asterisks, they meant two asterisks, and
 * quietly turning their own words bold would be the app editing them.
 */
export function RichText({
  text,
  style,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
}) {
  const blocks = parseBlocks(text);

  return (
    // Stretched on purpose: a parent that aligns its children to the start
    // would otherwise shrink this to its content and make every line wrap at
    // that width. Stated here as well as fixed at the call site, so dropping
    // this into some other row later cannot quietly reintroduce it.
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.kind === "blank") {
          return <View key={index} style={styles.gap} />;
        }
        if (block.kind === "bullet") {
          return (
            <View key={index} style={styles.bulletRow}>
              <Text style={[style, styles.bulletGlyph]}>•</Text>
              <Text style={[style, styles.bulletBody]}>{renderSpans(block.spans)}</Text>
            </View>
          );
        }
        return (
          <Text key={index} style={[style, block.kind === "heading" && styles.heading]}>
            {renderSpans(block.spans)}
          </Text>
        );
      })}
    </View>
  );
}

/** Nested <Text> rather than separate rows, so a bold word still wraps with
 *  the sentence around it instead of breaking the line. */
function renderSpans(spans: Span[]): React.ReactNode[] {
  return spans.map((span, index) => (
    <Text
      key={index}
      style={[
        span.bold && styles.bold,
        span.italic && styles.italic,
        span.code && styles.code,
      ]}
    >
      {span.text}
    </Text>
  ));
}

const styles = StyleSheet.create({
  container: {
    alignSelf: "stretch",
  },
  bold: {
    fontFamily: font.bodySemiBold,
  },
  italic: {
    fontStyle: "italic",
  },
  code: {
    fontFamily: font.mono,
    fontSize: 14,
    color: color.textSecondary,
  },
  heading: {
    fontFamily: font.display,
  },
  gap: {
    height: space.sm,
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
  },
  bulletGlyph: {
    color: color.textTertiary,
  },
  bulletBody: {
    flex: 1,
  },
});
