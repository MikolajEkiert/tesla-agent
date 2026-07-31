import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space, type } from "../theme";

/**
 * "Are you sure?", drawn by the app.
 *
 * This exists because `Alert.alert` is a no-op on the web — literally
 * `static alert() {}` in react-native-web — and the web is where this app
 * actually runs. Disconnecting the Tesla account was wired to it, so the long
 * press on the wordmark did precisely nothing on a phone, silently, with no
 * error to notice.
 *
 * One component for every destructive question, so the answer always looks and
 * behaves the same: the safe option is the wide, quiet one, and the button that
 * does the damage is the one that has to be aimed at.
 */
export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  /** Defaults to the shared "Cancel". */
  cancelLabel?: string;
  /** Paints the confirm button in the alert colour. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's back button and the web's Escape key both land here, which is
      // the same thing tapping the backdrop means.
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {body ? <Text style={styles.body}>{body}</Text> : null}
          <View style={styles.row}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.cancel, pressed && styles.cancelPressed]}
              accessibilityRole="button"
            >
              <Text style={styles.cancelText}>{cancelLabel ?? t("disconnectCancel")}</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.confirm,
                destructive && styles.confirmDestructive,
                pressed && styles.confirmPressed,
              ]}
              accessibilityRole="button"
            >
              <Text style={styles.confirmText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  card: {
    width: "100%",
    maxWidth: 400,
    padding: space.xl,
    borderRadius: radius.xl,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  title: {
    ...type.title,
    color: color.textPrimary,
  },
  body: {
    ...type.body,
    fontSize: 15,
    lineHeight: 22,
    color: color.textSecondary,
    marginTop: space.sm,
  },
  row: {
    flexDirection: "row",
    gap: space.sm,
    marginTop: space.lg,
  },
  cancel: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
  },
  cancelPressed: {
    backgroundColor: color.surfacePressed,
  },
  cancelText: {
    fontFamily: font.bodyMedium,
    fontSize: 15,
    color: color.textSecondary,
  },
  confirm: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.brand,
    alignItems: "center",
  },
  confirmDestructive: {
    backgroundColor: color.alert,
  },
  confirmPressed: {
    opacity: 0.75,
  },
  confirmText: {
    fontFamily: font.bodySemiBold,
    fontSize: 15,
    color: color.bg,
  },
});
