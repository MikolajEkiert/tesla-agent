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
import React, { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { disconnectTesla, fetchAuthStatus } from "./src/api";
import { LanguageProvider, useLanguage } from "./src/LanguageContext";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ConnectScreen } from "./src/screens/ConnectScreen";
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

  useEffect(() => {
    fetchAuthStatus()
      .then(setAuthStatus)
      // Backend unreachable, or /auth/status not deployed yet — fail open
      // to the chat screen rather than stranding the user on a blank gate.
      .catch(() => setAuthStatus({ required: false, connected: false }));
  }, []);

  const handleDisconnect = () => {
    disconnectTesla()
      .catch(() => {})
      .finally(() => setAuthStatus((prev) => (prev ? { ...prev, connected: false } : prev)));
  };

  if (!fontsLoaded || !authStatus || !languageReady) {
    return <View style={{ flex: 1, backgroundColor: color.bg }} />;
  }

  const needsConnection = authStatus.required && !authStatus.connected;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {needsConnection ? (
        <ConnectScreen errorMessage={notice.error} />
      ) : (
        <ChatScreen justConnected={notice.success} onDisconnect={handleDisconnect} />
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
