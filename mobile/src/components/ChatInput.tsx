import React, { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space } from "../theme";
import { primeSpeech } from "../voice/speak";
import { voiceInputSupported } from "../voice/recorder";
import { ConversationBar, ConversationButton, type ConversationPhase } from "./ConversationBar";
import { VoiceButton } from "./VoiceButton";

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
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);

  const canSend = text.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    // Still inside the tap, which is the only moment iOS lets us unlock speech.
    primeSpeech();
    onSend(text.trim());
    setText("");
  };

  // A running conversation takes over the whole bar: the text field, the send
  // button and the ordinary voice button all mean nothing while the mic is
  // already open and driving the exchange on its own.
  if (conversationActive) {
    return (
      <View style={styles.container}>
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
    <View style={styles.container}>
      {/* Sits above the bar rather than replacing the microphone, so the way to
          shut it up never moves and never depends on what else is on screen.
          Wide and short — it has to be hittable without looking. */}
      {speaking && (
        <Pressable onPress={onStopSpeaking} style={styles.stopBar}>
          <View style={styles.stopGlyph} />
          <Text style={styles.stopText}>
            {t("speechSpeaking")} · {t("speechStop")}
          </Text>
        </Pressable>
      )}
      {voiceStatus && !speaking && <Text style={styles.voiceStatus}>{voiceStatus}</Text>}
      <View style={[styles.bar, focused && styles.barFocused]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t("askPlaceholder")}
          placeholderTextColor={color.textTertiary}
          style={styles.input}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={submit}
          returnKeyType="send"
          multiline
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
        />
        {/* One button, not two: the microphone is the resting state and turns
            into send as soon as there is something to send. Two permanent
            buttons would crowd the bar and make the common action ambiguous. */}
        {canSend || text.length > 0 ? (
          <Pressable
            onPress={submit}
            disabled={!canSend}
            hitSlop={10}
            style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          >
            <Text style={styles.sendGlyph}>↑</Text>
          </Pressable>
        ) : (
          <>
            <VoiceButton
              onTranscript={(spoken) => onSend(spoken, true)}
              onStatus={setVoiceStatus}
              onLocked={onLocked}
              disabled={disabled}
            />
            {voiceInputSupported() && (
              <ConversationButton onPress={() => onStartConversation?.()} disabled={disabled} />
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: Platform.OS === "ios" ? space.lg : space.md,
    backgroundColor: color.bg,
  },
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    paddingVertical: space.sm,
  },
  barFocused: {
    borderColor: color.brand,
  },
  voiceStatus: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.textTertiary,
    paddingLeft: space.md,
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
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.brand,
  },
  stopGlyph: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: color.brand,
  },
  stopText: {
    fontFamily: font.bodySemiBold,
    fontSize: 13,
    color: color.brand,
  },
  input: {
    flex: 1,
    fontFamily: font.body,
    fontSize: 16,
    color: color.textPrimary,
    maxHeight: 110,
    paddingVertical: space.xs,
    // Belt-and-suspenders with the global reset in public/index.html (which
    // also kills the tap-highlight rectangle mobile browsers draw on touch —
    // that one can only be fixed globally, not via a RN style prop).
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
  },
  sendButton: {
    // 44x44 is the iOS/Android minimum comfortable tap target (was 34 —
    // hitSlop covers native, but its web support is inconsistent, so size
    // the box itself correctly instead of depending on it).
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: space.sm,
  },
  sendButtonDisabled: {
    backgroundColor: color.brandDim,
  },
  sendGlyph: {
    color: color.bg,
    fontSize: 16,
    fontFamily: font.displayBold,
  },
});
