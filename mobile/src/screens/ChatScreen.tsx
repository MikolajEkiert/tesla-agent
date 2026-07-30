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
  lock,
  NotUnlockedError,
  sendMessage,
} from "../api";
import { ChatInput } from "../components/ChatInput";
import { InstrumentStrip } from "../components/InstrumentStrip";
import { ConfirmCard } from "../components/ConfirmCard";
import { MessageRow } from "../components/MessageRow";
import { Sidebar } from "../components/Sidebar";
import { ToolLogLine } from "../components/ToolLogLine";
import { TypingDots } from "../components/TypingDots";
import { greeting } from "../i18n";
import { useLanguage } from "../LanguageContext";
import { SettingsScreen } from "./SettingsScreen";
import { color, font, space } from "../theme";
import {
  DEFAULT_SPEECH_MODE,
  isSpeaking,
  loadSpeechMode,
  saveSpeechMode,
  speak,
  stopSpeaking,
  type SpeechMode,
} from "../voice/speak";
import type { ChatItem, ScheduledAction, VehicleState } from "../types";

/** Countdowns in the drawer would otherwise sit frozen while it's open. */
const QUEUE_POLL_MS = 15000;

let nextId = 0;
const id = () => String(nextId++);

export function ChatScreen({
  justConnected,
  onDisconnect,
  onLocked,
}: {
  justConnected?: boolean;
  onDisconnect?: () => void;
  /** Session expired or the user locked the app — hand back to the gate. */
  onLocked?: () => void;
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
  const [speechMode, setSpeechMode] = useState<SpeechMode>(DEFAULT_SPEECH_MODE);
  const [speaking, setSpeaking] = useState(false);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [vehicle, setVehicle] = useState<VehicleState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);

  const refreshVehicle = useCallback(() => {
    fetchVehicleState()
      .then(setVehicle)
      .catch((e) => {
        // A lapsed session must send the user back to the passcode screen;
        // anything else just leaves the strip blank.
        if (e instanceof NotUnlockedError) onLocked?.();
      });
  }, [onLocked]);

  const refreshScheduled = useCallback(() => {
    fetchScheduledActions()
      .then(setScheduled)
      .catch((e) => {
        if (e instanceof NotUnlockedError) onLocked?.();
      });
  }, [onLocked]);

  useEffect(() => {
    refreshVehicle();
    refreshScheduled();
    loadSpeechMode().then(setSpeechMode);
    // Leaving the screen mid-sentence should not leave a voice talking to an
    // empty room — the synthesiser outlives the component otherwise.
    return stopSpeaking;
  }, [refreshVehicle, refreshScheduled]);

  /** Silence it and settle the UI. Every route to "stop talking" goes through
   *  here, so the stop button can never outlive the speech it belongs to. */
  const halt = useCallback(() => {
    stopSpeaking();
    setSpeaking(false);
  }, []);

  // The end event is not guaranteed — Safari has been known to drop it, and a
  // browser with no audio device fires nothing while still reporting that it
  // is speaking. Polling the engine means the stop button always disappears
  // when there is nothing left to stop. The delay covers the opposite race:
  // the engine takes a moment to report `speaking` after being handed work.
  useEffect(() => {
    if (!speaking) return;
    let poll: ReturnType<typeof setInterval>;
    const start = setTimeout(() => {
      poll = setInterval(() => {
        if (!isSpeaking()) setSpeaking(false);
      }, 500);
    }, 1000);
    return () => {
      clearTimeout(start);
      clearInterval(poll);
    };
  }, [speaking]);

  const changeSpeechMode = useCallback(
    (mode: SpeechMode) => {
      setSpeechMode(mode);
      saveSpeechMode(mode);
      if (mode === "off") halt();
    },
    [halt]
  );

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
    async (text: string, viaVoice?: boolean) => {
      setError(null);
      // Asking something new retires the previous answer, spoken one included.
      halt();
      setItems((prev) => [...prev, { kind: "message", id: id(), role: "user", text }]);
      setPending(true);
      try {
        const res = await sendMessage(text, history, language);
        setHistory(res.history);
        setItems((prev) => [
          ...prev,
          ...res.tool_trace.flatMap((call): ChatItem[] => {
            // A sensitive command comes back parked rather than executed, with
            // a token the card below trades for execution once tapped.
            const pending = call.result as
              | { confirmation_required?: boolean; confirm_token?: string }
              | undefined;
            const row: ChatItem = { kind: "tool", id: id(), call };
            if (pending?.confirmation_required && pending.confirm_token) {
              return [
                row,
                {
                  kind: "confirm",
                  id: id(),
                  token: pending.confirm_token,
                  tool: call.tool,
                },
              ];
            }
            return [row];
          }),
          { kind: "message", id: id(), role: "assistant", text: res.reply },
        ]);
        // Only the final reply is spoken — never the tool trace, and never a
        // pending confirmation as if it were the outcome. The model is already
        // told to say that something is waiting in the app (see
        // actions.propose), so that sentence is what gets read out.
        if (speechMode === "always" || (speechMode === "voice" && viaVoice)) {
          // Optimistic, not event-driven: the stop control has to exist from
          // the instant speech is asked for. Waiting for a start event would
          // leave the first moments unstoppable, and some engines never send
          // one at all. The watchdog below clears it either way.
          setSpeaking(true);
          speak(res.reply, language, { onEnd: () => setSpeaking(false) });
        }
        refreshVehicle();
        // A turn may have created or cancelled a timer — reflect it at once
        // instead of leaving the drawer stale until the next poll.
        refreshScheduled();
      } catch (e) {
        // BackendError means the backend responded — show its actual reason
        // (e.g. an LLM rate limit). Anything else is a real connectivity
        // failure (fetch never got a response at all).
        if (e instanceof NotUnlockedError) {
          onLocked?.();
        } else {
          setError(e instanceof BackendError ? e.message : t("errorUnreachable"));
        }
      } finally {
        setPending(false);
      }
    },
    [history, refreshVehicle, refreshScheduled, language, t, onLocked, speechMode, halt]
  );

  useEffect(() => {
    if (items.length) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [items, pending]);

  if (showSettings) {
    return (
      <SettingsScreen
        onClose={() => setShowSettings(false)}
        speechMode={speechMode}
        onSpeechModeChange={changeSpeechMode}
      />
    );
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
            ) : item.kind === "confirm" ? (
              <ConfirmCard
                token={item.token}
                tool={item.tool}
                onDone={() => {
                  refreshVehicle();
                  refreshScheduled();
                }}
                onDismiss={() => {}}
              />
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
        <ChatInput
          onSend={handleSend}
          disabled={pending}
          onLocked={onLocked}
          speaking={speaking}
          onStopSpeaking={halt}
        />
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
        onLock={() => {
          setMenuOpen(false);
          halt();
          lock().finally(() => onLocked?.());
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
