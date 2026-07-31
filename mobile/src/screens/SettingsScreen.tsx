import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
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
  fetchPersonaAdditions,
  fetchVoices,
  passkeysSupported,
  registerPasskey,
  type Passkey,
} from "../api";
import { useLanguage } from "../LanguageContext";
import type { Language, TranslationKey } from "../i18n";
import {
  BUILT_IN_HINTS,
  BUILT_IN_LABELS,
  BUILT_IN_PERSONAS,
  MAX_CUSTOM_PERSONAS,
  MAX_NAME_CHARS,
  MAX_STYLE_CHARS,
  isBuiltIn,
  type CustomPersona,
  type PersonaId,
} from "../persona";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { color, font, radius, space, type } from "../theme";
import {
  currentVoiceName,
  primeSpeech,
  setActiveVoice,
  speak,
  speechSupported,
  type SpeechMode,
  type VoiceChoice,
} from "../voice/speak";
import { voiceInputSupported } from "../voice/recorder";

const LANGUAGES: { code: Language; labelKey: "langEnglish" | "langPolish" }[] = [
  { code: "en", labelKey: "langEnglish" },
  { code: "pl", labelKey: "langPolish" },
];

/** A settings column stops being readable long before a window stops growing:
 *  three segments stretched across a laptop are three targets a metre apart. */
const SETTINGS_WIDTH = 720;

/** The clauses the server may append to a hand-written manner, in this app's
 *  words. Keyed by the ids /personas/preview returns; an id with no entry is
 *  simply not shown, so a newer server cannot print English at a Polish
 *  reader. */
const ADDITION_LABELS: Record<string, TranslationKey> = {
  terse: "personaAdditionTerse",
  length: "personaAdditionLength",
  facts: "personaAdditionFacts",
  consistency: "personaAdditionConsistency",
  spoken: "personaAdditionSpoken",
};

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
  bargeInEnabled,
  onBargeInChange,
  voiceConfirmEnabled,
  onVoiceConfirmChange,
  liveEnabled,
  onLiveChange,
  persona,
  onPersonaChange,
  customPersonas,
  onCustomPersonaSave,
  onCustomPersonaDelete,
}: {
  onClose: () => void;
  speechMode: SpeechMode;
  onSpeechModeChange: (mode: SpeechMode) => void;
  voiceChoice: VoiceChoice;
  onVoiceChange: (voice: VoiceChoice) => void;
  bargeInEnabled: boolean;
  onBargeInChange: (enabled: boolean) => void;
  voiceConfirmEnabled: boolean;
  onVoiceConfirmChange: (enabled: boolean) => void;
  liveEnabled: boolean;
  onLiveChange: (enabled: boolean) => void;
  persona: PersonaId;
  onPersonaChange: (persona: PersonaId) => void;
  customPersonas: CustomPersona[];
  /** Saves a new manner, or overwrites one when `id` is given. Storage and the
   *  selection that may follow it are the screen owner's business, not this
   *  form's — same division as the voice and language settings above. */
  onCustomPersonaSave: (name: string, style: string, id?: string) => void;
  onCustomPersonaDelete: (id: string) => void;
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
  // The manner editor. Null when closed; `{ id: undefined }` while writing a
  // new one, `{ id }` while rewriting an existing one — so the same form serves
  // both and the Save button knows which it is doing.
  const [editing, setEditing] = useState<{ id?: string } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftStyle, setDraftStyle] = useState("");
  // Deleting a manner is small but irreversible, and the app draws its own
  // dialog because Alert.alert does nothing on the web — see ConfirmDialog.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const personaFull = customPersonas.length >= MAX_CUSTOM_PERSONAS;

  /**
   * What Amp will add to the note being written.
   *
   * Asked of the server rather than worked out here: the rules that decide it
   * live next to the prompt they join, and a second copy in the app would
   * eventually disagree with the one that actually runs — which for a preview
   * is worse than having no preview at all.
   *
   * Debounced, because it would otherwise fire on every keystroke, and left
   * empty on any failure: this explains a thing that happens anyway, so a
   * dropped request costs the explanation and not the manner.
   */
  const [additions, setAdditions] = useState<string[]>([]);
  useEffect(() => {
    const style = draftStyle.trim();
    if (!editing || !style) {
      setAdditions([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      fetchPersonaAdditions(style)
        .then((ids) => current && setAdditions(ids))
        .catch(() => current && setAdditions([]));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draftStyle, editing]);

  const openEditor = (existing?: CustomPersona) => {
    setEditing({ id: existing?.id });
    setDraftName(existing?.name ?? "");
    setDraftStyle(existing?.style ?? "");
  };

  const closeEditor = () => {
    setEditing(null);
    setDraftName("");
    setDraftStyle("");
  };

  const saveDraft = () => {
    // A manner with no description would be a chip that does nothing, so the
    // style note is what makes it saveable; the name can be filled in from it
    // if left blank, which is kinder than refusing the whole form over a label.
    const style = draftStyle.trim();
    if (!style) return;
    const name = draftName.trim() || style.slice(0, MAX_NAME_CHARS);
    onCustomPersonaSave(name, style, editing?.id);
    closeEditor();
  };

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
    // Bottom only: this is rendered over the chat, inside a SafeAreaView that
    // has already stepped around the notch, and claiming the top inset a second
    // time pushed the header a notch's worth down the screen.
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {/* The rule spans the window; what sits on it does not. On a laptop a
          header pinned to both edges puts "Done" a hand's width from the title
          it belongs to. */}
      <View style={styles.header}>
        <View style={styles.headerInner}>
        <Text style={styles.title}>{t("settingsTitle")}</Text>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          style={({ pressed }) => [styles.closeButton, pressed && styles.pressedText]}
        >
          <Text style={styles.closeText}>{t("settingsClose")}</Text>
        </Pressable>
        </View>
      </View>

      {/* Scrolls, which it did not until now: the content was a plain View and
          everything past the fold — the voice picker, passkeys, the whole
          lower half — simply could not be reached on a phone. The header stays
          outside so "Close" is always in the same place. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.label}>{t("settingsLanguageLabel")}</Text>
        <View style={styles.segmented}>
          {LANGUAGES.map(({ code, labelKey }) => {
            const active = code === language;
            return (
              <Pressable
                key={code}
                onPress={() => setLanguage(code)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.segment,
                  active && styles.segmentActive,
                  pressed && !active && styles.pressedSurface,
                ]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {t(labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>{t("settingsLanguageHint")}</Text>

        {/* Above the speech settings and outside them on purpose: the manner
            applies to what is typed as much as to what is spoken, so burying
            it under "Spoken replies" would make it look like a voice option on
            a phone that cannot speak at all. */}
        <Text style={[styles.label, styles.sectionGap]}>{t("personaSection")}</Text>
        <View style={styles.voiceGrid}>
          {BUILT_IN_PERSONAS.map((option) => {
            const active = option === persona;
            return (
              <Pressable
                key={option}
                onPress={() => onPersonaChange(option)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.voiceChip,
                  active && styles.voiceChipActive,
                  pressed && !active && styles.pressedSurface,
                ]}
              >
                <Text style={[styles.voiceChipText, active && styles.voiceChipTextActive]}>
                  {t(BUILT_IN_LABELS[option])}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {/* What the chosen manner actually does, one line, under the grid it
            belongs to. A grid of four adjectives is not self-explanatory —
            "Formal" and "Standard" read as the same thing until you are told
            how they differ. */}
        <Text style={styles.personaDescription}>
          {isBuiltIn(persona)
            ? t(BUILT_IN_HINTS[persona])
            : customPersonas.find((p) => p.id === persona)?.style ?? ""}
        </Text>
        <Text style={styles.hint}>{t("personaHint")}</Text>

        <Text style={[styles.label, styles.sectionGap]}>
          {t("personaCustomSection")}
        </Text>
        {customPersonas.length > 0 && (
          <View style={styles.personaList}>
            {customPersonas.map((custom) => {
              const active = custom.id === persona;
              return (
                <View key={custom.id} style={styles.personaRow}>
                  <Pressable
                    onPress={() => onPersonaChange(custom.id)}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.personaPick,
                      active && styles.voiceChipActive,
                      pressed && !active && styles.pressedSurface,
                    ]}
                  >
                    <Text
                      style={[styles.voiceChipText, active && styles.voiceChipTextActive]}
                      numberOfLines={1}
                    >
                      {custom.name}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => openEditor(custom)}
                    hitSlop={8}
                    accessibilityRole="button"
                    style={({ pressed }) => pressed && styles.pressedText}
                  >
                    <Text style={styles.personaAction}>{t("personaCustomEdit")}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setPendingDelete(custom.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    style={({ pressed }) => pressed && styles.pressedText}
                  >
                    <Text style={styles.personaDelete}>{t("personaCustomDelete")}</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}

        {editing ? (
          <View style={styles.personaForm}>
            <TextInput
              value={draftName}
              onChangeText={setDraftName}
              placeholder={t("personaCustomNamePlaceholder")}
              placeholderTextColor={color.textTertiary}
              style={styles.enrolInput}
              maxLength={MAX_NAME_CHARS}
              autoCapitalize="sentences"
            />
            <TextInput
              value={draftStyle}
              onChangeText={setDraftStyle}
              placeholder={t("personaCustomStylePlaceholder")}
              placeholderTextColor={color.textTertiary}
              style={[styles.enrolInput, styles.personaStyleInput]}
              // Capped where it is typed as well as where it is stored and
              // again on the server: the one that matters is the server's, but
              // a limit you meet while writing is not a surprise afterwards.
              maxLength={MAX_STYLE_CHARS}
              multiline
              textAlignVertical="top"
            />
            {/* Shown before saving, not after: the point is that the owner
                can see what their note is missing while they still have the
                cursor in it, and either accept the addition or write the thing
                themselves. An id the app does not recognise is skipped rather
                than printed raw — a newer server may know rules this build
                has no words for. */}
            {additions.length > 0 && (
              <Text style={styles.personaAdditions}>
                {t("personaAdditions", {
                  items: additions
                    .map((id) => ADDITION_LABELS[id])
                    .filter(Boolean)
                    .map((key) => t(key))
                    .join(", "),
                })}
              </Text>
            )}
            <View style={styles.personaFormRow}>
              <Pressable
                onPress={closeEditor}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.personaSecondaryButton,
                  pressed && styles.pressedSurface,
                ]}
              >
                <Text style={styles.personaSecondaryText}>{t("personaCustomCancel")}</Text>
              </Pressable>
              <Pressable
                onPress={saveDraft}
                disabled={draftStyle.trim().length === 0}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.personaPrimaryButton,
                  (pressed || draftStyle.trim().length === 0) && styles.passkeyButtonMuted,
                ]}
              >
                <Text style={styles.passkeyButtonText}>{t("personaCustomSave")}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={() => openEditor()}
            disabled={personaFull}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.personaAddButton,
              (pressed || personaFull) && styles.pressedSurface,
            ]}
          >
            <Text style={styles.personaAddText}>{t("personaCustomAdd")}</Text>
          </Pressable>
        )}
        <Text style={styles.hint}>
          {personaFull && !editing ? t("personaCustomFull") : t("personaCustomHint")}
        </Text>

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
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.segment,
                      active && styles.segmentActive,
                      pressed && !active && styles.pressedSurface,
                    ]}
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
                        accessibilityRole="button"
                        style={({ pressed }) => [
                          styles.voiceChip,
                          active && styles.voiceChipActive,
                          pressed && !active && styles.pressedSurface,
                        ]}
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

        {voiceInputSupported() && (
          <>
            <Text style={[styles.label, styles.sectionGap]}>
              {t("conversationBargeInSection")}
            </Text>
            <View style={styles.segmented}>
              {(
                [
                  { value: true, labelKey: "conversationBargeInOn" },
                  { value: false, labelKey: "conversationBargeInOff" },
                ] as const
              ).map(({ value, labelKey }) => {
                const active = value === bargeInEnabled;
                return (
                  <Pressable
                    key={String(value)}
                    onPress={() => onBargeInChange(value)}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.segment,
                      active && styles.segmentActive,
                      pressed && !active && styles.pressedSurface,
                    ]}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {t(labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>{t("conversationBargeInHint")}</Text>

            <Text style={[styles.label, styles.sectionGap]}>
              {t("voiceConfirmSection")}
            </Text>
            <View style={styles.segmented}>
              {(
                [
                  { value: true, labelKey: "voiceConfirmOn" },
                  { value: false, labelKey: "voiceConfirmOff" },
                ] as const
              ).map(({ value, labelKey }) => {
                const active = value === voiceConfirmEnabled;
                return (
                  <Pressable
                    key={String(value)}
                    onPress={() => onVoiceConfirmChange(value)}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.segment,
                      active && styles.segmentActive,
                      pressed && !active && styles.pressedSurface,
                    ]}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {t(labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>{t("voiceConfirmHint")}</Text>

            <Text style={[styles.label, styles.sectionGap]}>{t("liveSection")}</Text>
            <View style={styles.segmented}>
              {(
                [
                  { value: true, labelKey: "liveOn" },
                  { value: false, labelKey: "liveOff" },
                ] as const
              ).map(({ value, labelKey }) => {
                const active = value === liveEnabled;
                return (
                  <Pressable
                    key={String(value)}
                    onPress={() => onLiveChange(value)}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.segment,
                      active && styles.segmentActive,
                      pressed && !active && styles.pressedSurface,
                    ]}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {t(labelKey)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>{t("liveHint")}</Text>
          </>
        )}

        <Text style={[styles.label, styles.sectionGap]}>{t("passkeySection")}</Text>
        {!passkeysSupported() ? (
          <Text style={styles.hint}>{t("passkeyUnsupported")}</Text>
        ) : passkeys.length > 0 ? (
          <>
            <View style={styles.passkeyRow}>
              <Text style={styles.passkeyLabel}>{t("passkeyAdded")}</Text>
              <Pressable
                onPress={() => removePasskey(passkeys[0].credential_id)}
                hitSlop={8}
                accessibilityRole="button"
                style={({ pressed }) => pressed && styles.pressedText}
              >
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
      </ScrollView>

      <ConfirmDialog
        visible={pendingDelete !== null}
        title={t("personaCustomDeleteTitle")}
        body={t("personaCustomDeleteBody")}
        confirmLabel={t("personaCustomDelete")}
        onConfirm={() => {
          if (pendingDelete) onCustomPersonaDelete(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: color.bg,
  },
  header: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  headerInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    maxWidth: SETTINGS_WIDTH,
    alignSelf: "center",
  },
  title: {
    ...type.title,
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
  scroll: {
    flex: 1,
  },
  content: {
    padding: space.lg,
    width: "100%",
    maxWidth: SETTINGS_WIDTH,
    alignSelf: "center",
    // Room past the last control, so the bottom row is not pressed against the
    // home indicator when the list is scrolled to the end.
    paddingBottom: space.xl * 2,
  },
  // Section names in the machine's own voice, like the instrument log — they
  // name a capability of the car, not a page of a form.
  label: {
    ...type.eyebrow,
    color: color.textTertiary,
    marginBottom: space.md,
  },
  segmented: {
    flexDirection: "row",
    backgroundColor: color.surface,
    borderRadius: radius.pill,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: color.brand,
  },
  // Only the inactive options need this: the selected one is already painted
  // in the brand colour, and dimming the thing you just chose reads as the
  // choice failing to take.
  pressedSurface: {
    backgroundColor: color.surfaceHover,
  },
  pressedText: {
    opacity: 0.55,
  },
  segmentText: {
    ...type.label,
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
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
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
  // What the selected manner does, in the app's own voice rather than the
  // machine's — this is prose about a choice, not a reading off an instrument,
  // so it takes the body face and not the mono one the diagnostics below use.
  personaDescription: {
    ...type.body,
    fontSize: 13,
    lineHeight: 19,
    color: color.textSecondary,
    marginTop: space.md,
  },
  personaList: {
    gap: space.sm,
    marginBottom: space.md,
  },
  // A row rather than a chip: a manner the owner wrote needs "Edit" and
  // "Delete" beside it, and hanging those off a chip in a wrapping grid puts
  // them wherever the wrap happens to fall.
  personaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  personaPick: {
    flex: 1,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
  },
  personaAction: {
    fontFamily: font.bodyMedium,
    fontSize: 13,
    color: color.brand,
  },
  personaDelete: {
    fontFamily: font.bodyMedium,
    fontSize: 13,
    color: color.alert,
  },
  personaForm: {
    gap: space.sm,
  },
  // Room for the two or three sentences a style note actually is, without
  // becoming a text editor.
  personaStyleInput: {
    minHeight: 96,
  },
  // Quieter than the note it comments on: this is Amp explaining itself, not
  // an error and not a requirement.
  personaAdditions: {
    ...type.body,
    fontSize: 12,
    lineHeight: 17,
    color: color.textTertiary,
    marginTop: space.xs,
    marginBottom: space.xs,
  },
  personaFormRow: {
    flexDirection: "row",
    gap: space.sm,
  },
  personaPrimaryButton: {
    flex: 1,
    paddingVertical: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.brand,
    alignItems: "center",
  },
  personaSecondaryButton: {
    flex: 1,
    paddingVertical: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
  },
  personaSecondaryText: {
    fontFamily: font.bodySemiBold,
    fontSize: 15,
    color: color.textSecondary,
  },
  // Outlined rather than filled: adding a manner is an offer, and a second
  // solid brand-coloured button under the picker would compete with the choice
  // the owner came here to make.
  personaAddButton: {
    paddingVertical: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
  },
  personaAddText: {
    fontFamily: font.bodySemiBold,
    fontSize: 15,
    color: color.brand,
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
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    ...type.body,
    fontSize: 15,
    color: color.textPrimary,
    marginBottom: space.sm,
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
  },
  passkeyButton: {
    paddingVertical: space.lg,
    borderRadius: radius.lg,
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
    ...type.body,
    fontSize: 13,
    lineHeight: 19,
    color: color.textTertiary,
    marginTop: space.md,
  },
});
