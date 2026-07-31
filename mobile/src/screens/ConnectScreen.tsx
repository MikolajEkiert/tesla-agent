import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { startTeslaLogin } from "../api";
import { AmpMark } from "../components/AmpMark";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space, type } from "../theme";

/**
 * Gates the app until the Tesla account is linked (only shown when the
 * backend is running the fleet adapter — the mock adapter skips this
 * entirely, see App.tsx). One job: get the user to /auth/login.
 */
export function ConnectScreen({ errorMessage }: { errorMessage?: string | null }) {
  const { t } = useLanguage();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.content}>
        <View style={styles.mark}>
          <AmpMark size={40} />
        </View>
        <Text style={styles.brand}>AMP</Text>
        <Text style={styles.headline}>{t("connectHeadline")}</Text>
        <Text style={styles.body}>{t("connectBody")}</Text>

        {errorMessage && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        <Pressable
          onPress={startTeslaLogin}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>{t("connectButton")}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: color.bg,
  },
  content: {
    flex: 1,
    width: "100%",
    maxWidth: 420,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
  },
  // The mark carries the accent on its own here, with nothing behind it.
  mark: {
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
    color: color.textPrimary,
    textAlign: "center",
    marginBottom: space.md,
  },
  body: {
    ...type.body,
    fontSize: 15,
    lineHeight: 22,
    color: color.textSecondary,
    textAlign: "center",
    marginBottom: space.xxl,
  },
  errorBox: {
    width: "100%",
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.alertSoft,
    borderWidth: 1,
    borderColor: color.alert,
    marginBottom: space.lg,
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
  },
  buttonPressed: {
    backgroundColor: color.brandDim,
  },
  buttonText: {
    fontFamily: font.bodySemiBold,
    fontSize: 16,
    color: color.bg,
  },
});
