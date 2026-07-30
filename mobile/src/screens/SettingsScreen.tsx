import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  BackendError,
  deletePasskey,
  fetchPasskeys,
  passkeysSupported,
  registerPasskey,
  type Passkey,
} from "../api";
import { useLanguage } from "../LanguageContext";
import type { Language } from "../i18n";
import { color, font, radius, space } from "../theme";

const LANGUAGES: { code: Language; labelKey: "langEnglish" | "langPolish" }[] = [
  { code: "en", labelKey: "langEnglish" },
  { code: "pl", labelKey: "langPolish" },
];

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { language, setLanguage, t } = useLanguage();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  // Enrolling a credential re-asks for the passcode: a session alone would let
  // a borrowed unlocked phone add a permanent key of its own.
  const [enrolPasscode, setEnrolPasscode] = useState("");

  const refreshPasskeys = useCallback(() => {
    fetchPasskeys()
      .then(setPasskeys)
      .catch(() => setPasskeys([]));
  }, []);

  useEffect(refreshPasskeys, [refreshPasskeys]);

  const addPasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await registerPasskey(enrolPasscode, undefined, "iPhone");
      setEnrolPasscode("");
      refreshPasskeys();
    } catch (e) {
      const message = e instanceof BackendError ? e.message : String((e as Error)?.message ?? "");
      // Declining the Face ID prompt is a choice, not a failure to report.
      if (!/cancel|abort|NotAllowed/i.test(message)) {
        setPasskeyError(message || t("errorUnreachable"));
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    await deletePasskey(id).catch(() => {});
    refreshPasskeys();
  };

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

        <Text style={[styles.label, styles.sectionGap]}>{t("passkeySection")}</Text>
        {!passkeysSupported() ? (
          <Text style={styles.hint}>{t("passkeyUnsupported")}</Text>
        ) : passkeys.length > 0 ? (
          <>
            <View style={styles.passkeyRow}>
              <Text style={styles.passkeyLabel}>{t("passkeyAdded")}</Text>
              <Pressable onPress={() => removePasskey(passkeys[0].credential_id)} hitSlop={8}>
                <Text style={styles.passkeyRemove}>{t("passkeyRemove")}</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>{t("passkeyHint")}</Text>
          </>
        ) : (
          <>
            <TextInput
              value={enrolPasscode}
              onChangeText={setEnrolPasscode}
              placeholder={t("passkeyPasscodePrompt")}
              placeholderTextColor={color.textTertiary}
              style={styles.enrolInput}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              onPress={addPasskey}
              disabled={passkeyBusy || enrolPasscode.length === 0}
              style={({ pressed }) => [
                styles.passkeyButton,
                (pressed || enrolPasscode.length === 0) && styles.passkeyButtonMuted,
              ]}
            >
              {passkeyBusy ? (
                <ActivityIndicator color={color.bg} />
              ) : (
                <Text style={styles.passkeyButtonText}>{t("passkeyAdd")}</Text>
              )}
            </Pressable>
            <Text style={styles.hint}>{t("passkeyHint")}</Text>
          </>
        )}
        {passkeyError && <Text style={styles.passkeyError}>{passkeyError}</Text>}
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
  sectionGap: {
    marginTop: space.xl,
  },
  enrolInput: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    fontFamily: font.body,
    fontSize: 15,
    color: color.textPrimary,
    marginBottom: space.sm,
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
  },
  passkeyButton: {
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.brand,
    alignItems: "center",
  },
  passkeyButtonMuted: { backgroundColor: color.brandDim },
  passkeyButtonText: {
    fontFamily: font.bodySemiBold,
    fontSize: 15,
    color: color.bg,
  },
  passkeyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: space.sm,
  },
  passkeyLabel: {
    fontFamily: font.bodyMedium,
    fontSize: 14,
    color: color.textPrimary,
  },
  passkeyRemove: {
    fontFamily: font.bodyMedium,
    fontSize: 13,
    color: color.alert,
  },
  passkeyError: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.alert,
    marginTop: space.sm,
  },
  hint: {
    fontFamily: font.body,
    fontSize: 13,
    lineHeight: 18,
    color: color.textTertiary,
    marginTop: space.md,
  },
});
