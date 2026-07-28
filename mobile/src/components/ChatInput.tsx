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

export function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}) {
  const { t } = useLanguage();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);

  const canSend = text.trim().length > 0 && !disabled;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <View style={styles.container}>
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
        <Pressable
          onPress={submit}
          disabled={!canSend}
          hitSlop={10}
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        >
          <Text style={styles.sendGlyph}>↑</Text>
        </Pressable>
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
