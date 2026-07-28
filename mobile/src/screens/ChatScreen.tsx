import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  BackendError,
  cancelScheduledAction,
  fetchScheduledActions,
  fetchVehicleState,
  sendMessage,
} from "../api";
import { ChatInput } from "../components/ChatInput";
import { InstrumentStrip } from "../components/InstrumentStrip";
import { MessageRow } from "../components/MessageRow";
import { Sidebar } from "../components/Sidebar";
import { ToolLogLine } from "../components/ToolLogLine";
import { TypingDots } from "../components/TypingDots";
import { greeting } from "../i18n";
import { useLanguage } from "../LanguageContext";
import { SettingsScreen } from "./SettingsScreen";
import { color, font, space } from "../theme";
import type { ChatItem, ScheduledAction, VehicleState } from "../types";

/** Countdowns in the drawer would otherwise sit frozen while it's open. */
const QUEUE_POLL_MS = 15000;

let nextId = 0;
const id = () => String(nextId++);

export function ChatScreen({
  justConnected,
  onDisconnect,
}: {
  justConnected?: boolean;
  onDisconnect?: () => void;
}) {
  const { language, t } = useLanguage();
  const [showSettings, setShowSettings] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scheduled, setScheduled] = useState<ScheduledAction[]>([]);
  const [items, setItems] = useState<ChatItem[]>([
    {
      kind: "message",
      id: id(),
      role: "assistant",
      text: justConnected ? t("connectedGreeting") : greeting(language, new Date().getHours()),
    },
  ]);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [vehicle, setVehicle] = useState<VehicleState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);

  const refreshVehicle = useCallback(() => {
    fetchVehicleState()
      .then(setVehicle)
      .catch(() => {
        /* strip just shows nothing if the backend is unreachable */
      });
  }, []);

  const refreshScheduled = useCallback(() => {
    fetchScheduledActions()
      .then(setScheduled)
      .catch(() => {
        /* drawer just shows an empty queue if the backend is unreachable */
      });
  }, []);

  useEffect(() => {
    refreshVehicle();
    refreshScheduled();
  }, [refreshVehicle, refreshScheduled]);

  // Timers tick down server-side, so the queue has to be re-read rather than
  // counted down locally — a stop job that already fired should stop showing
  // "stops in 1 min".
  useEffect(() => {
    const id = setInterval(refreshScheduled, QUEUE_POLL_MS);
    return () => clearInterval(id);
  }, [refreshScheduled]);

  const handleCancelAction = useCallback(
    (actionId: string) => {
      cancelScheduledAction(actionId)
        .catch(() => {})
        .finally(() => {
          refreshScheduled();
          refreshVehicle();
        });
    },
    [refreshScheduled, refreshVehicle]
  );

  // The opening greeting is generated once at mount, before the user has
  // picked a language — if they open Settings and switch it before saying
  // anything, re-render that one message so it doesn't stay stuck in
  // whatever language happened to be active on mount. Once a real exchange
  // has happened (items.length > 1), this is a no-op — actual conversation
  // history is never retranslated.
  useEffect(() => {
    setItems((prev) => {
      if (prev.length !== 1 || prev[0].kind !== "message") return prev;
      const text = justConnected ? t("connectedGreeting") : greeting(language, new Date().getHours());
      return [{ ...prev[0], text }];
    });
  }, [language, justConnected, t]);

  const handleSend = useCallback(
    async (text: string) => {
      setError(null);
      setItems((prev) => [...prev, { kind: "message", id: id(), role: "user", text }]);
      setPending(true);
      try {
        const res = await sendMessage(text, history, language);
        setHistory(res.history);
        setItems((prev) => [
          ...prev,
          ...res.tool_trace.map(
            (call): ChatItem => ({ kind: "tool", id: id(), call })
          ),
          { kind: "message", id: id(), role: "assistant", text: res.reply },
        ]);
        refreshVehicle();
        // A turn may have created or cancelled a timer — reflect it at once
        // instead of leaving the drawer stale until the next poll.
        refreshScheduled();
      } catch (e) {
        // BackendError means the backend responded — show its actual reason
        // (e.g. an LLM rate limit). Anything else is a real connectivity
        // failure (fetch never got a response at all).
        setError(e instanceof BackendError ? e.message : t("errorUnreachable"));
      } finally {
        setPending(false);
      }
    },
    [history, refreshVehicle, refreshScheduled, language, t]
  );

  useEffect(() => {
    if (items.length) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [items, pending]);

  if (showSettings) {
    return <SettingsScreen onClose={() => setShowSettings(false)} />;
  }

  const activeActions = scheduled.filter(
    (a) => a.state === "scheduled" || a.state === "running"
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <InstrumentStrip
        state={vehicle}
        onDisconnect={onDisconnect}
        onOpenMenu={() => {
          refreshScheduled();
          setMenuOpen(true);
        }}
        activeActionCount={activeActions.length}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) =>
            item.kind === "message" ? (
              <MessageRow role={item.role} text={item.text} />
            ) : (
              <ToolLogLine call={item.call} />
            )
          }
          ListFooterComponent={pending ? <TypingDots /> : null}
        />
        {error && (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        <ChatInput onSend={handleSend} disabled={pending} />
      </KeyboardAvoidingView>

      <Sidebar
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={scheduled}
        onCancelAction={handleCancelAction}
        onOpenSettings={() => {
          setMenuOpen(false);
          setShowSettings(true);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: color.bg,
  },
  flex: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  errorBar: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 8,
    backgroundColor: "rgba(226,86,79,0.12)",
    borderWidth: 1,
    borderColor: color.alert,
  },
  errorText: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.alert,
  },
});
