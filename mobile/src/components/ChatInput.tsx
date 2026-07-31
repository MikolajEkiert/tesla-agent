import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../LanguageContext";
import { color, radius, space, type } from "../theme";
import { primeSpeech } from "../voice/speak";
import { voiceInputSupported } from "../voice/recorder";
import { ConversationBar, ConversationButton, type ConversationPhase } from "./ConversationBar";
import { IconArrowUp } from "./icons";
import { VoiceButton } from "./VoiceButton";

/**
 * The composer.
 *
 * Two rows rather than one, which is what every assistant has converged on and
 * what a car needs anyway: the field gets the full width, and the three ways to
 * start something — hold to talk, open a conversation, send what you typed —
 * each get a target of their own that never moves. The old bar swapped the
 * microphone out for a send button the moment you typed a character, so the
 * control under your thumb depended on what was in the field.
 */
export function ChatInput({
  onSend,
  disabled,
  onLocked,
  speaking,
  onStopSpeaking,
  conversationActive,
  conversationPhase,
  conversationLevel,
  onStartConversation,
  onConversationTap,
  onEndConversation,
}: {
  /** `viaVoice` decides whether the reply gets read aloud — see SpeechMode. */
  onSend: (text: string, viaVoice?: boolean) => void;
  disabled: boolean;
  onLocked?: () => void;
  speaking?: boolean;
  onStopSpeaking?: () => void;
  conversationActive?: boolean;
  conversationPhase?: ConversationPhase;
  conversationLevel?: number;
  onStartConversation?: () => void;
  onConversationTap?: () => void;
  onEndConversation?: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  // The one place the bottom inset is spent. `max`, not a sum: the screen used
  // to add the safe-area clearance and this bar its own padding on top, which
  // on a phone with a home indicator left the bar hanging well clear of the
  // bottom edge.
  const bottomPad = Math.max(insets.bottom, space.md);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);

  const canSend = text.trim().length > 0 && !disabled;

  /**
   * Enter sends — but only where there is a real keyboard.
   *
   * The field is multiline, and on web that means `onSubmitEditing` never
   * fires: Enter just inserts a line break, so on a desktop the only way to
   * send was reaching for the mouse. Shift+Enter still breaks the line, which
   * is the convention every chat app has trained people on.
   */
  const hasKeyboard =
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

  const handleKeyPress = (event: any) => {
    if (!hasKeyboard) return;
    const key = event?.nativeEvent?.key;
    if (key !== "Enter" || event?.nativeEvent?.shiftKey) return;
    event.preventDefault?.();
    submit();
  };

  const submit = () => {
    if (!canSend) return;
    // Still inside the tap, which is the only moment iOS lets us unlock speech.
    primeSpeech();
    onSend(text.trim());
    setText("");
  };

  // A running conversation takes over the whole bar: the field, the send button
  // and the microphone all mean nothing while the mic is already open and
  // driving the exchange on its own.
  if (conversationActive) {
    return (
      <View style={[styles.container, { paddingBottom: bottomPad }]}>
        <ConversationBar
          phase={conversationPhase ?? "listening"}
          level={conversationLevel ?? 0}
          onTap={() => onConversationTap?.()}
          onEnd={() => onEndConversation?.()}
        />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: bottomPad }]}>
      {/* Sits above the composer rather than replacing a control inside it, so
          the way to shut it up never moves and never depends on what else is on
          screen. Wide and short — it has to be hittable without looking. */}
      {speaking && (
        <Pressable
          onPress={onStopSpeaking}
          accessibilityRole="button"
          style={({ pressed }) => [styles.stopBar, pressed && styles.stopBarPressed]}
        >
          <View style={styles.stopGlyph} />
          <Text style={styles.stopText}>
            {t("speechSpeaking")} · {t("speechStop")}
          </Text>
        </Pressable>
      )}
      {voiceStatus && !speaking && <Text style={styles.voiceStatus}>{voiceStatus}</Text>}

      <View style={[styles.composer, focused && styles.composerFocused]}>
        <TextInput
          value={text}
          // Whitespace alone is nothing typed. Belt and braces for the Enter
          // handler above — if a browser inserts the line break anyway before
          // preventDefault lands, the field would otherwise be left holding a
          // lone newline, which looks empty but enables the send button.
          onChangeText={(value) => setText(value.trim().length === 0 ? "" : value)}
          placeholder={t("askPlaceholder")}
          placeholderTextColor={color.textTertiary}
          style={styles.input}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={submit}
          onKeyPress={handleKeyPress}
          returnKeyType="send"
          multiline
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
        />
        <View style={styles.tools}>
          <View style={styles.toolsLeading}>
            <VoiceButton
              onTranscript={(spoken) => onSend(spoken, true)}
              onStatus={setVoiceStatus}
              onLocked={onLocked}
              disabled={disabled}
            />
            {voiceInputSupported() && (
              <ConversationButton onPress={() => onStartConversation?.()} disabled={disabled} />
            )}
          </View>
          <Pressable
            onPress={submit}
            disabled={!canSend}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("sendMessage")}
            style={({ pressed }) => [
              styles.sendButton,
              !canSend && styles.sendButtonDisabled,
              pressed && canSend && styles.sendButtonPressed,
            ]}
          >
            <IconArrowUp size={18} color={canSend ? color.bg : color.textTertiary} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    // paddingBottom comes from the safe-area inset at the call site above.
    backgroundColor: color.bg,
  },
  composer: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  composerFocused: {
    borderColor: color.brand,
  },
  input: {
    ...type.body,
    color: color.textPrimary,
    maxHeight: 132,
    minHeight: 26,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    // Belt-and-suspenders with the global reset in public/index.html.
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
  },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolsLeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  sendButton: {
    // See ConversationBar: 44 is the minimum comfortable target, and hitSlop is
    // not a substitute for it on the web.
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    backgroundColor: color.surfaceHover,
  },
  sendButtonPressed: {
    opacity: 0.75,
  },
  voiceStatus: {
    ...type.caption,
    color: color.textTertiary,
    paddingLeft: space.lg,
    paddingBottom: space.xs,
  },
  stopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    marginBottom: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.brandSoft,
    borderWidth: 1,
    borderColor: color.brand,
  },
  stopBarPressed: {
    backgroundColor: color.surfacePressed,
  },
  stopGlyph: {
    width: 9,
    height: 9,
    borderRadius: 2,
    backgroundColor: color.brand,
  },
  stopText: {
    ...type.label,
    color: color.brand,
  },
});
