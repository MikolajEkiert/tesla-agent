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
  transcribe,
} from "../api";
import { ChatInput } from "../components/ChatInput";
import type { ConversationPhase } from "../components/ConversationBar";
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
  DEFAULT_VOICE,
  isSpeaking,
  loadSpeechMode,
  loadVoiceChoice,
  primeSpeech,
  saveSpeechMode,
  saveVoiceChoice,
  setActiveVoice,
  speak,
  stopSpeaking,
  type SpeechMode,
  type VoiceChoice,
} from "../voice/speak";
import {
  loadBargeIn,
  NothingRecordedError,
  saveBargeIn,
  VoiceRecorder,
  voiceInputSupported,
} from "../voice/recorder";
import type { ChatItem, ScheduledAction, VehicleState } from "../types";

/** How long a hush has to hold, once the driver has started talking, before a
 *  conversation turn is treated as finished. Long enough to survive an
 *  ordinary breath mid-sentence, short enough that the assistant doesn't feel
 *  like it stopped listening. */
const CONVERSATION_SILENCE_MS = 1100;

/** Level under which the cabin counts as quiet, for deciding the speaker has
 *  finished. Deliberately only a loudness figure: whether any of it was
 *  *speech* is a different question, decided on frequency content in
 *  voice/vad.ts, because loud and spoken are not the same thing — hitting the
 *  seat proved it by producing a command nobody said. */
const CONVERSATION_QUIET_LEVEL = 0.02;

/** How long to hold the microphone open for a turn where nothing resembling
 *  speech ever arrives, before handing back an empty turn and listening
 *  again. Without it such a turn runs to MAX_SECONDS — half a minute of dead
 *  air in the middle of a conversation. */
const CONVERSATION_NO_SPEECH_MS = 8000;

/** Empty turns in a row before the conversation closes itself. Without it the
 *  loop listens forever: a phone left in a parked car keeps the microphone
 *  open, the recording indicator lit, and the loop spinning, long after
 *  whoever started it has walked away. Three turns is about half a minute of
 *  nothing — enough to survive a red light or a thought mid-sentence. */
const CONVERSATION_MAX_EMPTY_TURNS = 3;

/**
 * Peak level that counts as a deliberate interruption while the assistant is
 * talking, rather than its own reply leaking back through imperfect echo
 * cancellation. Set well above CONVERSATION_SPEECH_THRESHOLD on purpose:
 * residual echo after cancellation is usually much quieter than near-field
 * speech, but "usually" is doing real work in that sentence — this is a
 * starting guess, not a measurement, and the Settings toggle exists because
 * of exactly that uncertainty.
 */
const BARGE_IN_THRESHOLD = 0.15;

/** How long the level has to hold above that threshold before it counts as a
 *  real interruption — filters out a single loud click (a door, a bump) that
 *  a spoken sentence would not produce. */
const BARGE_IN_SUSTAIN_MS = 250;

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
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>(DEFAULT_VOICE);
  const [speaking, setSpeaking] = useState(false);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [vehicle, setVehicle] = useState<VehicleState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);

  // A continuous voice exchange: listen, send, hear the reply, listen again —
  // until the driver ends it. See handleConversationTap and startConversation
  // below for the actual loop; these hold the state the bar renders.
  const [conversationActive, setConversationActive] = useState(false);
  const [conversationPhase, setConversationPhase] = useState<ConversationPhase>("listening");
  const [conversationLevel, setConversationLevel] = useState(0);
  const [bargeInEnabled, setBargeInEnabled] = useState(true);
  // Mirrors conversationActive for code that runs outside React's render
  // cycle — a recorder's onAutoStop, a speak() callback fired seconds later —
  // where state from the render that scheduled it may already be stale.
  const conversationActiveRef = useRef(false);
  const conversationRecorderRef = useRef<VoiceRecorder | null>(null);
  // A second, parallel microphone session that runs only while a reply is
  // being spoken — its one job is noticing a real interruption. Separate from
  // conversationRecorderRef because the two exist at different times and mean
  // different things: this one detects, that one captures.
  const bargeInWatcherRef = useRef<VoiceRecorder | null>(null);
  // Consecutive turns where nothing was said. Reset by any real transcript.
  const emptyTurnsRef = useRef(0);
  // Indirection so handleSend's useCallback deps don't have to include
  // functions that are themselves redefined every render (and that in turn
  // call handleSend) — that pair would otherwise be circular.
  const listenAgainRef = useRef<() => void>(() => {});
  const stopConversationRef = useRef<() => void>(() => {});
  const startBargeInWatcherRef = useRef<() => void>(() => {});
  const stopBargeInWatcherRef = useRef<() => void>(() => {});

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
    // Told to the speech module as well as held in state: speak() is called
    // from an event handler and cannot wait on storage at that point.
    loadVoiceChoice().then((choice) => {
      setVoiceChoice(choice);
      setActiveVoice(choice);
    });
    loadBargeIn().then(setBargeInEnabled);
    // Leaving the screen mid-sentence should not leave a voice talking to an
    // empty room — the synthesiser outlives the component otherwise. Same
    // reasoning for a conversation's open microphone, capturing or watching.
    return () => {
      stopSpeaking();
      conversationRecorderRef.current?.cancel();
      bargeInWatcherRef.current?.cancel();
    };
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

  const changeVoice = useCallback((choice: VoiceChoice) => {
    setVoiceChoice(choice);
    setActiveVoice(choice);
    saveVoiceChoice(choice);
  }, []);

  const changeBargeIn = useCallback((enabled: boolean) => {
    setBargeInEnabled(enabled);
    saveBargeIn(enabled);
    // Switching it off mid-reply should stop watching immediately, not just
    // for the next turn — otherwise "Tap only" would silently not apply
    // until the conversation loop happened to restart.
    if (!enabled) {
      bargeInWatcherRef.current?.cancel();
      bargeInWatcherRef.current = null;
    }
  }, []);

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
    async (text: string, viaVoice?: boolean, conversationTurn?: boolean) => {
      setError(null);
      // Asking something new retires the previous answer, spoken one included.
      halt();
      setItems((prev) => [...prev, { kind: "message", id: id(), role: "user", text }]);
      setPending(true);
      if (conversationTurn) setConversationPhase("thinking");
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
        //
        // A conversation turn speaks regardless of the stored speech mode: a
        // voice conversation with a silent assistant makes no sense, and the
        // silence would also strand the loop with nothing to cue the next
        // listen.
        if (conversationTurn || speechMode === "always" || (speechMode === "voice" && viaVoice)) {
          // Optimistic, not event-driven: the stop control has to exist from
          // the instant speech is asked for. Waiting for a start event would
          // leave the first moments unstoppable, and some engines never send
          // one at all. The watchdog below clears it either way.
          setSpeaking(true);
          if (conversationTurn) {
            setConversationPhase("speaking");
            startBargeInWatcherRef.current();
          }
          speak(res.reply, language, {
            onEnd: () => {
              setSpeaking(false);
              if (conversationTurn) {
                // Reached the end without an interruption — nothing left to
                // watch for. If a barge-in ended the reply early instead, this
                // callback never runs at all: halt() bumps speak.ts's
                // generation, and a stopped reply's own onEnd is suppressed.
                stopBargeInWatcherRef.current();
                listenAgainRef.current();
              }
            },
          });
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
        // A turn that failed to even get an answer has nothing to loop back
        // to — end the conversation instead of sitting in "thinking" forever
        // or, worse, silently retrying into a server that is already down.
        if (conversationTurn) stopConversationRef.current();
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
        voiceChoice={voiceChoice}
        onVoiceChange={changeVoice}
        bargeInEnabled={bargeInEnabled}
        onBargeInChange={changeBargeIn}
      />
    );
  }

  const activeActions = scheduled.filter(
    (a) => a.state === "scheduled" || a.state === "running"
  );

  // --- Conversation mode -----------------------------------------------
  //
  // Not memoized with useCallback: these four call each other (listenAgain
  // schedules finishConversationTurn, which calls handleSend, whose onEnd
  // calls back into listenAgain via listenAgainRef), and none of them are
  // passed anywhere that needs referential stability across renders — only
  // invoked from event handlers and from refs that are reassigned every
  // render to whichever closure is current. Plain functions sidestep the
  // circular-dependency problem a useCallback chain here would otherwise have.

  const stopBargeInWatcher = () => {
    bargeInWatcherRef.current?.cancel();
    bargeInWatcherRef.current = null;
  };
  stopBargeInWatcherRef.current = stopBargeInWatcher;

  const startBargeInWatcher = () => {
    if (!bargeInEnabled) return;
    const watcher = new VoiceRecorder();
    watcher.onset = { threshold: BARGE_IN_THRESHOLD, sustainMs: BARGE_IN_SUSTAIN_MS };
    watcher.onOnset = () => {
      // A real interruption: stop the reply immediately and start capturing
      // the sentence that cut it off — the same action a tap on the bar
      // already performs, just triggered by a voice instead of a finger.
      stopBargeInWatcher();
      halt();
      listenAgain();
    };
    bargeInWatcherRef.current = watcher;
    watcher.start().catch(() => {
      // No mic to spare, or permission got pulled mid-reply. The reply just
      // finishes normally and a tap still interrupts it — barge-in silently
      // isn't available for this one turn rather than breaking the loop.
      bargeInWatcherRef.current = null;
    });
  };
  startBargeInWatcherRef.current = startBargeInWatcher;

  const stopConversation = () => {
    conversationActiveRef.current = false;
    setConversationActive(false);
    stopBargeInWatcher();
    conversationRecorderRef.current?.cancel();
    conversationRecorderRef.current = null;
    halt();
  };
  stopConversationRef.current = stopConversation;

  const listenAgain = () => {
    // Guards against the same turn being started twice — the real case is a
    // barge-in tap and a cancelled utterance's stray onend both trying to
    // reopen the microphone for the same moment. Whichever gets here first
    // sets the ref; the second sees it already populated and backs off.
    if (!conversationActiveRef.current || conversationRecorderRef.current) return;
    setConversationPhase("listening");
    setConversationLevel(0);
    const recorder = new VoiceRecorder();
    recorder.endpointing = {
      quietLevel: CONVERSATION_QUIET_LEVEL,
      silenceMs: CONVERSATION_SILENCE_MS,
      noSpeechTimeoutMs: CONVERSATION_NO_SPEECH_MS,
    };
    recorder.onLevel = setConversationLevel;
    recorder.onAutoStop = () => void finishConversationTurn();
    conversationRecorderRef.current = recorder;
    recorder.start().catch(() => {
      // Permission revoked mid-conversation, or the device took the mic away
      // (a phone call arriving). Nothing left to listen with.
      conversationRecorderRef.current = null;
      stopConversation();
    });
  };
  listenAgainRef.current = listenAgain;

  /** Nothing was said this turn. Listen again, but not forever. */
  const emptyTurn = () => {
    emptyTurnsRef.current += 1;
    if (emptyTurnsRef.current >= CONVERSATION_MAX_EMPTY_TURNS) {
      stopConversation();
      return;
    }
    listenAgain();
  };

  const finishConversationTurn = async () => {
    const recorder = conversationRecorderRef.current;
    if (!recorder) return;
    conversationRecorderRef.current = null;
    setConversationPhase("thinking");
    try {
      const blob = await recorder.stop();
      const text = (await transcribe(blob, language)).trim();
      if (!text) {
        // The recording had speech-shaped audio in it but the transcriber
        // returned nothing — either it genuinely heard no words, or the
        // backend's own audio check rejected it. Either way, nobody spoke.
        emptyTurn();
        return;
      }
      emptyTurnsRef.current = 0;
      await handleSend(text, true, true);
    } catch (e) {
      if (e instanceof NothingRecordedError) {
        // Silence the whole turn, or a recording too short to be speech —
        // ordinary in a car (a red light, a thought interrupted).
        emptyTurn();
      } else if (e instanceof NotUnlockedError) {
        stopConversation();
        onLocked?.();
      } else {
        // Transcription itself failed (quota, no signal) — stop rather than
        // spin through the same failure every couple of seconds.
        stopConversation();
      }
    }
  };

  const startConversation = () => {
    if (!voiceInputSupported() || conversationActiveRef.current) return;
    setError(null);
    emptyTurnsRef.current = 0;
    // Still inside the tap, which is the only moment iOS lets us unlock
    // speech — every later turn in the loop plays without one.
    primeSpeech();
    conversationActiveRef.current = true;
    setConversationActive(true);
    listenAgain();
  };

  const handleConversationTap = () => {
    if (conversationPhase === "listening") {
      // Don't make the driver wait out the silence timer once they know
      // they're done — the same "release early" affordance hold-to-talk
      // gives for free by construction.
      void finishConversationTurn();
    } else if (conversationPhase === "speaking") {
      // Manual interrupt — works the same whether or not voice barge-in is
      // on, and is the only way to interrupt at all when it's off (see the
      // Settings toggle: echo cancellation isn't reliable on every phone and
      // car speaker, so this stays available regardless).
      stopBargeInWatcher();
      halt();
      listenAgain();
    }
    // "thinking": nothing to interrupt yet.
  };
  // --- end conversation mode ---------------------------------------------

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
          conversationActive={conversationActive}
          conversationPhase={conversationPhase}
          conversationLevel={conversationLevel}
          onStartConversation={startConversation}
          onConversationTap={handleConversationTap}
          onEndConversation={stopConversation}
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
          // Stops the conversation's open microphone too, not just any
          // speech — a locked app listening in the background would be a
          // strange thing to discover.
          stopConversation();
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
