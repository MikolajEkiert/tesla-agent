import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { startTeslaLogin } from "../api";
import { useLanguage } from "../LanguageContext";
import { color, font, radius, space } from "../theme";

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
        <View style={styles.bolt} />
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
    fontSize: 26,
    color: color.textPrimary,
    textAlign: "center",
    marginBottom: space.md,
  },
  body: {
    fontFamily: font.body,
    fontSize: 15,
    lineHeight: 22,
    color: color.textSecondary,
    textAlign: "center",
    marginBottom: space.xxl,
  },
  errorBox: {
    width: "100%",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 8,
    backgroundColor: "rgba(226,86,79,0.12)",
    borderWidth: 1,
    borderColor: color.alert,
    marginBottom: space.lg,
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
