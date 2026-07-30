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
  fetchVoices,
  passkeysSupported,
  registerPasskey,
  type Passkey,
} from "../api";
import { useLanguage } from "../LanguageContext";
import type { Language, TranslationKey } from "../i18n";
import { color, font, radius, space } from "../theme";
import {
  currentVoiceName,
  primeSpeech,
  setActiveVoice,
  speak,
  speechSupported,
  type SpeechMode,
  type VoiceChoice,
} from "../voice/speak";

const LANGUAGES: { code: Language; labelKey: "langEnglish" | "langPolish" }[] = [
  { code: "en", labelKey: "langEnglish" },
  { code: "pl", labelKey: "langPolish" },
];

const SPEECH_MODES: { mode: SpeechMode; labelKey: TranslationKey }[] = [
  { mode: "off", labelKey: "speechOff" },
  { mode: "voice", labelKey: "speechVoice" },
  { mode: "always", labelKey: "speechAlways" },
];

export function SettingsScreen({
  onClose,
  speechMode,
  onSpeechModeChange,
  voiceChoice,
  onVoiceChange,
}: {
  onClose: () => void;
  speechMode: SpeechMode;
  onSpeechModeChange: (mode: SpeechMode) => void;
  voiceChoice: VoiceChoice;
  onVoiceChange: (voice: VoiceChoice) => void;
}) {
  const { language, setLanguage, t } = useLanguage();
  // Served by the backend rather than listed here, so the names the app offers
  // and the names the synthesiser accepts cannot drift apart. An empty list
  // (old backend, no signal) leaves just the phone voice, which still works.
  const [voices, setVoices] = useState<string[]>([]);
  // Why the phone answered instead of the voice that was tapped. Null until
  // something actually goes wrong, so the screen stays quiet when it works.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  useEffect(() => {
    fetchVoices()
      .then((v) => setVoices(v.voices))
      .catch(() => setVoices([]));
  }, []);

  /**
   * Choosing and hearing are one action.
   *
   * "Iapetus" and "Umbriel" tell you nothing, so a picker that only selected
   * would be a list of riddles. Speaking on tap also primes the audio element
   * on the tap itself, which is exactly the gesture iOS wants.
   */
  const previewVoice = (option: VoiceChoice) => {
    primeSpeech();
    onVoiceChange(option);
    setActiveVoice(option);
    setFallbackReason(null);
    speak(t("speechVoiceSample"), language, {
      onFallback: setFallbackReason,
    });
  };
  // Safari fills the voice list asynchronously, so this can be null on the
  // first render and correct a moment later.
  const [voiceName, setVoiceName] = useState<string | null>(null);
  useEffect(() => {
    setVoiceName(currentVoiceName(language));
    const timer = setTimeout(() => setVoiceName(currentVoiceName(language)), 400);
    return () => clearTimeout(timer);
  }, [language]);
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

        {speechSupported() && (
          <>
            <Text style={[styles.label, styles.sectionGap]}>{t("speechSection")}</Text>
            <View style={styles.segmented}>
              {SPEECH_MODES.map(({ mode, labelKey }) => {
                const active = mode === speechMode;
                return (
                  <Pressable
                    key={mode}
                    onPress={() => onSpeechModeChange(mode)}
                    style={[styles.segment, active && styles.segmentActive]}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {t(labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>{t("speechHint")}</Text>
            {speechMode !== "off" && (
              <>
                <Text style={[styles.label, styles.sectionGap]}>
                  {t("speechVoiceSection")}
                </Text>
                <View style={styles.voiceGrid}>
                  {["device", ...voices].map((option) => {
                    const active = option === voiceChoice;
                    return (
                      <Pressable
                        key={option}
                        onPress={() => previewVoice(option)}
                        style={[styles.voiceChip, active && styles.voiceChipActive]}
                      >
                        <Text
                          style={[styles.voiceChipText, active && styles.voiceChipTextActive]}
                        >
                          {option === "device" ? t("speechVoiceDevice") : option}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.hint}>{t("speechVoiceHint")}</Text>
                {fallbackReason && (
                  <Text style={styles.voiceFallback}>
                    {t("speechVoiceFallback", { reason: fallbackReason })}
                  </Text>
                )}
                {voiceChoice === "device" && (
                  <>
                    {voiceName && (
                      <Text style={styles.voiceName}>
                        {t("speechVoiceLabel", { name: voiceName })}
                      </Text>
                    )}
                    {/* The stock Polish voice is the compact one and sounds
                        like it. The better version is a free download in iOS
                        Settings, and Amp switches to it by itself — so the
                        only thing missing is knowing it exists. Shown only
                        for the phone voice: it is advice about a voice you
                        are not otherwise using. */}
                    <Text style={styles.hint}>{t("speechVoiceUpgrade")}</Text>
                  </>
                )}
              </>
            )}
          </>
        )}

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
  // Wraps rather than scrolls: the list is short and fixed, and a row that
  // scrolls sideways hides options from someone glancing at it in a car.
  voiceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  voiceChip: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
  },
  voiceChipActive: {
    backgroundColor: color.brand,
  },
  voiceChipText: {
    fontSize: 14,
    color: color.textSecondary,
  },
  voiceChipTextActive: {
    color: color.bg,
    fontFamily: font.bodySemiBold,
  },
  // Monospaced like the voice name below it: this is diagnostic text, and it
  // should read as the machine reporting rather than the app apologising. The
  // accent palette is reserved for vehicle systems, so it stays neutral.
  voiceFallback: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.textSecondary,
    marginTop: space.sm,
  },
  voiceName: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.textSecondary,
    marginTop: space.md,
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
