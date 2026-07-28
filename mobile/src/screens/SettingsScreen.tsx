import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLanguage } from "../LanguageContext";
import type { Language } from "../i18n";
import { color, font, radius, space } from "../theme";

const LANGUAGES: { code: Language; labelKey: "langEnglish" | "langPolish" }[] = [
  { code: "en", labelKey: "langEnglish" },
  { code: "pl", labelKey: "langPolish" },
];

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { language, setLanguage, t } = useLanguage();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("settingsTitle")}</Text>
        <Pressable onPress={onClose} hitSlop={12} style={styles.closeButton}>
          <Text style={styles.closeText}>{t("settingsClose")}</Text>
        </Pressable>
      </View>

      <View style={styles.content}>
        <Text style={styles.label}>{t("settingsLanguageLabel")}</Text>
        <View style={styles.segmented}>
          {LANGUAGES.map(({ code, labelKey }) => {
            const active = code === language;
            return (
              <Pressable
                key={code}
                onPress={() => setLanguage(code)}
                style={[styles.segment, active && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {t(labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{t("settingsLanguageHint")}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: color.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  title: {
    fontFamily: font.display,
    fontSize: 18,
    color: color.textPrimary,
  },
  closeButton: {
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
  },
  closeText: {
    fontFamily: font.bodySemiBold,
    fontSize: 15,
    color: color.brand,
  },
  content: {
    padding: space.lg,
  },
  label: {
    fontFamily: font.bodyMedium,
    fontSize: 13,
    color: color.textSecondary,
    marginBottom: space.sm,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: color.brand,
  },
  segmentText: {
    fontFamily: font.bodyMedium,
    fontSize: 14,
    color: color.textSecondary,
  },
  segmentTextActive: {
    color: color.bg,
    fontFamily: font.bodySemiBold,
  },
  hint: {
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 18,
    color: color.textTertiary,
    marginTop: space.md,
  },
});
