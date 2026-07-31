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
import { AmpMark } from "../components/AmpMark";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space, type } from "../theme";

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
          <View style={styles.mark}>
            <AmpMark size={34} />
          </View>
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
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  mark: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.lg,
  },
  brand: {
    fontFamily: font.displayBold,
    fontSize: 13,
    letterSpacing: 4,
    color: color.textTertiary,
    marginBottom: space.xl,
  },
  headline: {
    ...type.hero,
    fontSize: 26,
    lineHeight: 32,
    color: color.textPrimary,
    textAlign: "center",
    marginBottom: space.sm,
  },
  body: {
    ...type.body,
    fontSize: 15,
    lineHeight: 22,
    color: color.textSecondary,
    textAlign: "center",
    marginBottom: space.xl,
  },
  input: {
    width: "100%",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    ...type.body,
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
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.alertSoft,
    borderWidth: 1,
    borderColor: color.alert,
    marginBottom: space.md,
  },
  errorText: {
    ...type.caption,
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
    ...type.caption,
    color: color.textTertiary,
    marginVertical: space.md,
  },
  buttonText: {
    fontFamily: font.bodySemiBold,
    fontSize: 16,
    color: color.bg,
  },
});
