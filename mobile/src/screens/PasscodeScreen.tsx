import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BackendError, loginWithPasskey, passkeysSupported, unlock } from "../api";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space } from "../theme";

/**
 * Gates the app until the passcode is entered. Distinct from ConnectScreen,
 * which links the *Tesla account*: that authenticates this server to Tesla and
 * says nothing about who is holding the phone. Without this screen anyone who
 * loaded the URL could unlock the car.
 */
export function PasscodeScreen({
  totpRequired,
  passkeyAvailable,
  onUnlocked,
}: {
  totpRequired: boolean;
  /** A passkey is enrolled server-side, so Face ID is worth offering. */
  passkeyAvailable?: boolean;
  onUnlocked: () => void;
}) {
  const { t } = useLanguage();
  const [passcode, setPasscode] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    passcode.length > 0 && (!totpRequired || totp.length === 6) && !busy;

  const canUsePasskey = Boolean(passkeyAvailable) && passkeysSupported();

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
      onUnlocked();
    } catch (e) {
      // A cancelled Face ID prompt throws too; treating it as a hard error
      // would shout at the user for simply changing their mind.
      const message = e instanceof BackendError ? e.message : String((e as Error)?.message ?? "");
      if (!/cancel|abort|NotAllowed/i.test(message)) {
        setError(message || t("errorUnreachable"));
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(passcode, totpRequired ? totp : undefined);
      setPasscode("");
      setTotp("");
      onUnlocked();
    } catch (e) {
      setError(e instanceof BackendError ? e.message : t("errorUnreachable"));
      setTotp("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.content}>
          <View style={styles.bolt} />
          <Text style={styles.brand}>AMP</Text>
          <Text style={styles.headline}>{t("passcodeHeadline")}</Text>
          <Text style={styles.body}>{t("passcodeBody")}</Text>

          {canUsePasskey && (
            <>
              <Pressable
                onPress={signInWithPasskey}
                disabled={busy}
                style={({ pressed }) => [styles.button, pressed && styles.buttonMuted]}
              >
                <Text style={styles.buttonText}>{t("passkeySignIn")}</Text>
              </Pressable>
              <Text style={styles.divider}>{t("passkeyOr")}</Text>
            </>
          )}

          <TextInput
            value={passcode}
            onChangeText={setPasscode}
            placeholder={t("passcodePlaceholder")}
            placeholderTextColor={color.textTertiary}
            style={styles.input}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={submit}
            returnKeyType={totpRequired ? "next" : "go"}
          />

          {totpRequired && (
            <TextInput
              value={totp}
              onChangeText={(v) => setTotp(v.replace(/\D/g, "").slice(0, 6))}
              placeholder={t("passcodeTotpPlaceholder")}
              placeholderTextColor={color.textTertiary}
              style={[styles.input, styles.totpInput]}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              onSubmitEditing={submit}
              returnKeyType="go"
            />
          )}

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <Pressable
            onPress={submit}
            disabled={!canSubmit}
            style={({ pressed }) => [
              styles.button,
              (!canSubmit || pressed) && styles.buttonMuted,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={color.bg} />
            ) : (
              <Text style={styles.buttonText}>{t("passcodeSubmit")}</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xxl,
  },
  bolt: {
    width: 40,
    height: 40,
    marginBottom: space.lg,
    backgroundColor: color.brand,
    borderRadius: radius.sm,
    transform: [{ rotate: "12deg" }],
  },
  brand: {
    fontFamily: font.displayBold,
    fontSize: 14,
    letterSpacing: 4,
    color: color.textSecondary,
    marginBottom: space.xl,
  },
  headline: {
    fontFamily: font.display,
    fontSize: 24,
    color: color.textPrimary,
    textAlign: "center",
    marginBottom: space.sm,
  },
  body: {
    fontFamily: font.body,
    fontSize: 14,
    lineHeight: 20,
    color: color.textSecondary,
    textAlign: "center",
    marginBottom: space.xl,
  },
  input: {
    width: "100%",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    fontFamily: font.body,
    fontSize: 16,
    color: color.textPrimary,
    marginBottom: space.md,
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
  },
  totpInput: {
    fontFamily: font.mono,
    letterSpacing: 6,
    textAlign: "center",
  },
  errorBox: {
    width: "100%",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: "rgba(226,86,79,0.12)",
    borderWidth: 1,
    borderColor: color.alert,
    marginBottom: space.md,
  },
  errorText: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.alert,
  },
  button: {
    width: "100%",
    paddingVertical: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.brand,
    alignItems: "center",
    marginTop: space.xs,
  },
  buttonMuted: { backgroundColor: color.brandDim },
  divider: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.textTertiary,
    marginVertical: space.md,
  },
  buttonText: {
    fontFamily: font.bodySemiBold,
    fontSize: 16,
    color: color.bg,
  },
});
