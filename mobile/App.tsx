import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
} from "@expo-google-fonts/manrope";
import {
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import {
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  disconnectTesla,
  fetchAuthStatus,
  fetchGateStatus,
  type GateStatus,
} from "./src/api";
import { LanguageProvider, useLanguage } from "./src/LanguageContext";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ConnectScreen } from "./src/screens/ConnectScreen";
import { PasscodeScreen } from "./src/screens/PasscodeScreen";
import { color } from "./src/theme";
import type { AuthStatus } from "./src/types";

/**
 * Reads ?tesla_auth=success|error&message=... left by the /auth/callback
 * redirect (see backend/app/main.py), then strips it from the URL so a
 * refresh doesn't replay it. Web only — there's no query string to read on
 * native, which doesn't drive this callback today.
 */
function useAuthCallbackNotice(): { success: boolean; error: string | null } {
  const [notice] = useState(() => {
    if (Platform.OS !== "web") return { success: false, error: null };
    const params = new URLSearchParams(window.location.search);
    const status = params.get("tesla_auth");
    return {
      success: status === "success",
      error: status === "error" ? params.get("message") : null,
    };
  });

  useEffect(() => {
    if (Platform.OS === "web" && window.location.search.includes("tesla_auth")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  return notice;
}

function AppInner() {
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });

  const notice = useAuthCallbackNotice();
  const { ready: languageReady } = useLanguage();
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [gateStatus, setGateStatus] = useState<GateStatus | null>(null);
  const [unlocked, setUnlocked] = useState<boolean | null>(null);

  // Probing /auth/status doubles as the session check: it is behind the gate,
  // so a 401 means "locked" rather than "broken". One request answers both
  // questions.
  const probe = useCallback(() => {
    fetchAuthStatus()
      .then((status) => {
        setAuthStatus(status);
        setUnlocked(true);
      })
      .catch(() => {
        // Any failure to confirm a session — 401, network error, an edge
        // proxy demanding its own credentials — lands on the passcode
        // screen. An earlier version fell through to the chat whenever the
        // cause wasn't a clean 401, which rendered a fully working-looking
        // chat over a backend that refused every request. The gate screen is
        // the honest representation of "not confirmed", and unlocking from
        // there surfaces the real error if the backend is genuinely down.
        setUnlocked(false);
      });
  }, []);

  useEffect(() => {
    fetchGateStatus()
      .then(setGateStatus)
      .catch(() =>
        setGateStatus({ configured: false, totp_required: false, passkey_available: false })
      );
    probe();
  }, [probe]);

  const handleDisconnect = () => {
    disconnectTesla()
      .catch(() => {})
      .finally(() => setAuthStatus((prev) => (prev ? { ...prev, connected: false } : prev)));
  };

  if (!fontsLoaded || !languageReady || unlocked === null) {
    return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  }

  // Passcode first: linking a Tesla account, or anything else, should not be
  // reachable by a stranger who merely opened the URL.
  if (!unlocked) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <PasscodeScreen
          totpRequired={gateStatus?.totp_required ?? false}
          passkeyAvailable={gateStatus?.passkey_available}
          onUnlocked={probe}
        />
      </SafeAreaProvider>
    );
  }

  if (!authStatus) {
    return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  }

  const needsConnection = authStatus.required && !authStatus.connected;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {needsConnection ? (
        <ConnectScreen errorMessage={notice.error} />
      ) : (
        <ChatScreen
          justConnected={notice.success}
          onDisconnect={handleDisconnect}
          onLocked={() => setUnlocked(false)}
        />
      )}
    </SafeAreaProvider>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppInner />
    </LanguageProvider>
  );
}
