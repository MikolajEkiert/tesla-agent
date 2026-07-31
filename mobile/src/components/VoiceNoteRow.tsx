import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLanguage } from "../LanguageContext";
import { spokenFor } from "../i18n";
import { color, font, radius, space } from "../theme";

/**
 * The driver's turn in a spoken conversation: that they spoke, and for how
 * long. Never what they said.
 *
 * This replaces a quotation that was not one. The live session runs a second
 * recogniser over the driver's audio purely to produce that text, and the
 * model doing the answering never sees it — measured in the car, it wrote
 * "najbliższego Superchargera" over a correctly heard "Orlenu" while the
 * assistant found the petrol station without trouble. A row that quotes it
 * reports words nobody said, and leaves the driver unable to tell a mishearing
 * from a misreading.
 *
 * So the row keeps only what this side can be sure of. Drawn on the driver's
 * side of the column like the message it replaces, but quiet and without a
 * bubble: it is a note about the conversation, not a line in it, and nothing
 * about it invites being read as speech.
 */
export function VoiceNoteRow({ seconds }: { seconds: number }) {
  const { language } = useLanguage();

  return (
    <View style={styles.row}>
      <View style={styles.note}>
        {/* Three bars, the same mark the composer uses for a live
            conversation, so the row is recognisable as one at a glance. */}
        <View style={styles.bars}>
          <View style={[styles.bar, styles.barShort]} />
          <View style={styles.bar} />
          <View style={[styles.bar, styles.barShort]} />
        </View>
        <Text style={styles.text}>{spokenFor(language, seconds)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: space.lg,
  },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    // Outlined rather than filled: a filled bubble is what a quotation looks
    // like here, and this is deliberately not one.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
  },
  bars: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  bar: {
    width: 2,
    height: 11,
    borderRadius: 1,
    backgroundColor: color.brand,
  },
  barShort: {
    height: 6,
  },
  text: {
    fontFamily: font.bodyMedium,
    fontSize: 13,
    color: color.textSecondary,
  },
});
