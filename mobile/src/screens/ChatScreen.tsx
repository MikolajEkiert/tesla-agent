import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
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
  confirmByVoice,
} from "../api";
import { ChatInput } from "../components/ChatInput";
import type { ConversationPhase } from "../components/ConversationBar";
import { IconChevronDown, IconClose } from "../components/icons";
import { InstrumentStrip } from "../components/InstrumentStrip";
import { ConfirmCard } from "../components/ConfirmCard";
import { MessageRow } from "../components/MessageRow";
import { Sidebar } from "../components/Sidebar";
import { ToolLogLine } from "../components/ToolLogLine";
import { TypingDots } from "../components/TypingDots";
import {
  type ChatSummary,
  deleteChat,
  isWorthSaving,
  loadChat,
  loadIndex,
  loadLastChatId,
  newChatId,
  rememberLastChat,
  renameChat,
  saveChat,
  titleFor,
} from "../chats";
import { greetingParts } from "../i18n";
import { useLanguage } from "../LanguageContext";
import { SettingsScreen } from "./SettingsScreen";
import { SuggestionChips } from "../components/SuggestionChips";
import { color, font, radius, READING_WIDTH, space, type, WIDE_LAYOUT } from "../theme";
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
  loadLiveMode,
  loadVoiceConfirm,
  NothingRecordedError,
  saveBargeIn,
  saveLiveMode,
  saveVoiceConfirm,
  VoiceRecorder,
  voiceInputSupported,
} from "../voice/recorder";
import { LiveSession, liveSupported } from "../voice/live";
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

/**
 * How often the instrument strip re-reads the car.
 *
 * It used to read it exactly twice: once on mount, and again after a turn that
 * touched something. Open the app in the morning, ask nothing, and the battery
 * figure at the top was the one from yesterday evening — stated in the present
 * tense, with no hint of its age. Slower than the queue because most of these
 * requests answer "still asleep, here is the same snapshot".
 */
const VEHICLE_POLL_MS = 60000;

/**
 * How often the level meter is allowed to move the UI.
 *
 * The recorder emits a level per audio frame — 128 samples, so roughly 375
 * times a second at 48 kHz — and this screen was handing that straight to
 * setState. Every one of those re-rendered the whole chat, transcript included,
 * for a ring that is 10 points across. VoiceButton has always throttled it;
 * this path never did.
 */
const LEVEL_INTERVAL_MS = 100;

/** How close to the bottom still counts as "reading the latest", and so still
 *  gets scrolled along by a new message. */
const AT_BOTTOM_SLACK_PX = 80;

/** How long the screen keeps following a reply that is still uncovering
 *  itself. Matches the reveal in MessageRow, with a little slack. */
const REVEAL_FOLLOW_MS = 900;

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
  // Conversations on disk, newest first, and which one is on screen. The id is
  // mirrored in a ref because the save effect below runs from a timer, where
  // the state of the render that scheduled it may already be a chat ago.
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string>(() => newChatId());
  const chatIdRef = useRef(activeChatId);
  // Nothing is written until the stored chat has been read back, or the first
  // render would save its empty greeting over the conversation being restored.
  const [restored, setRestored] = useState(false);
  // Set just before a conversation is put on screen from storage, and spent by
  // the very next save. Loading is not a change: without this, opening an old
  // chat would immediately write it back with a fresh timestamp and shuffle it
  // to the top of the list, so merely looking at a conversation would reorder
  // the history.
  const skipSaveRef = useRef(false);
  const [scheduled, setScheduled] = useState<ScheduledAction[]>([]);
  // Empty, not "empty apart from a greeting".
  //
  // The greeting used to be a real assistant message: first in the list, first
  // in the transcript, and saved into every stored conversation once chats
  // started persisting. It read as something the assistant had said, which
  // made a brand-new chat look like one already in progress. It is a
  // placeholder, so it is rendered as one — see ListEmptyComponent below.
  const [items, setItems] = useState<ChatItem[]>([]);
  const [speechMode, setSpeechMode] = useState<SpeechMode>(DEFAULT_SPEECH_MODE);
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>(DEFAULT_VOICE);
  const [speaking, setSpeaking] = useState(false);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [vehicle, setVehicle] = useState<VehicleState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What to send again if the driver taps "try again", and which row to take
  // with it — otherwise a retry would leave the failed message behind and add
  // a second copy underneath it.
  const [failed, setFailed] = useState<{
    text: string;
    viaVoice?: boolean;
    rowId: string;
  } | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);
  // Whether the transcript is scrolled to the end. New messages only drag the
  // view along when it is: scrolling up to re-read something and being yanked
  // back down by a reply that has not been read yet is the worst of both.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_LAYOUT;
  // The one reply currently uncovering itself. Held by id so a re-render, a
  // restored conversation or a second answer can never restart an old one.
  const [revealId, setRevealId] = useState<string | null>(null);
  const opening = greetingParts(language, new Date().getHours());
  // The left-edge strip that opens the drawer. Held as a ref so its DOM node
  // can be told to refuse the browser's own back-swipe — see the effect below.
  const edgeRef = useRef<View>(null);

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
  // When the meter last moved the UI. See LEVEL_INTERVAL_MS.
  const lastLevelAt = useRef(0);
  // A second, parallel microphone session that runs only while a reply is
  // being spoken — its one job is noticing a real interruption. Separate from
  // conversationRecorderRef because the two exist at different times and mean
  // different things: this one detects, that one captures.
  const bargeInWatcherRef = useRef<VoiceRecorder | null>(null);
  // Consecutive turns where nothing was said. Reset by any real transcript.
  const emptyTurnsRef = useRef(0);
  const [voiceConfirmEnabled, setVoiceConfirmEnabled] = useState(true);
  // The one card a spoken word may settle right now. Set when a gated command
  // comes back parked during a conversation; cleared the moment it is settled,
  // refused, or superseded — so the word can never apply to a card the driver
  // has stopped thinking about.
  const awaitingVoiceConfirmRef = useRef<{ token: string; tool: string } | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  // Non-null while a conversation is running over the live audio session. Its
  // presence is what the rest of the loop branches on: with a session open the
  // recorder, the transcription call and Cloud TTS are all bypassed.
  const liveRef = useRef<LiveSession | null>(null);
  // Indirection so handleSend's useCallback deps don't have to include
  // functions that are themselves redefined every render (and that in turn
  // call handleSend) — that pair would otherwise be circular.
  const listenAgainRef = useRef<() => void>(() => {});
  const stopConversationRef = useRef<() => void>(() => {});
  const startBargeInWatcherRef = useRef<() => void>(() => {});
  const stopBargeInWatcherRef = useRef<() => void>(() => {});

  /** The meter, at a rate a screen can actually show. */
  const reportLevel = useCallback((value: number) => {
    const now = Date.now();
    if (now - lastLevelAt.current < LEVEL_INTERVAL_MS) return;
    lastLevelAt.current = now;
    setConversationLevel(value);
  }, []);

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

  // Claims only a decisive rightward drag: a vertical scroll that happens to
  // begin at the left edge still belongs to the list, and a tap still belongs
  // to whatever is under it.
  const edgeSwipe = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (g.dx <= 40) return;
          refreshScheduled();
          setMenuOpen(true);
        },
      }),
    [refreshScheduled]
  );

  /**
   * Take the left edge away from the browser.
   *
   * A drag from that edge is the browser's own "go back" gesture, so opening
   * the drawer also navigated out of the app — the drawer appeared and the
   * page went back at the same time. Claiming the gesture in React is not
   * enough: the responder system runs above the browser, which has already
   * decided what an edge swipe means.
   *
   * So the default is refused at the DOM, on non-passive listeners — the only
   * kind whose preventDefault a browser honours for touch. The listeners have
   * to be attached by hand because React attaches its own as passive, where
   * preventDefault is silently ignored. `touch-action: none` says the same
   * thing declaratively, which is what Chrome reads; iOS wants the explicit
   * refusal. Both, because the two browsers do not agree.
   *
   * Nothing is lost by swallowing these: the strip is 16 points of the list's
   * own padding, with nothing under it to tap or scroll.
   */
  useEffect(() => {
    if (Platform.OS !== "web" || menuOpen) return;
    const node = edgeRef.current as unknown as HTMLElement | null;
    if (!node) return;
    node.style.touchAction = "none";
    const refuse = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };
    node.addEventListener("touchstart", refuse, { passive: false });
    node.addEventListener("touchmove", refuse, { passive: false });
    return () => {
      node.removeEventListener("touchstart", refuse);
      node.removeEventListener("touchmove", refuse);
    };
  }, [menuOpen]);

  /** Bring back the conversation that was open when the tab last closed. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const index = await loadIndex();
      const last = await loadLastChatId();
      const chat = last ? await loadChat(last) : null;
      if (cancelled) return;
      setChats(index);
      if (chat) {
        skipSaveRef.current = true;
        setItems(chat.items);
        setHistory(chat.history);
        chatIdRef.current = chat.id;
        setActiveChatId(chat.id);
      }
      setRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Write the conversation as it changes.
   *
   * Debounced, because a live turn appends several rows in a row and a spoken
   * reply arrives a fragment at a time — saving on each would rewrite the
   * whole body dozens of times a sentence.
   *
   * A live conversation is stored as its transcript only. Its context lives in
   * the session held by Google, not in `history`, so reopening the chat later
   * shows what was said without the live assistant remembering it. That is the
   * same separation the two assistants have everywhere else.
   */
  useEffect(() => {
    if (!restored || !isWorthSaving(items)) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void saveChat({
        id: chatIdRef.current,
        title: titleFor(items),
        updatedAt: Date.now(),
        items,
        history,
      }).then(setChats);
      void rememberLastChat(chatIdRef.current);
    }, 600);
    return () => clearTimeout(timer);
  }, [items, history, restored]);

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
    loadVoiceConfirm().then(setVoiceConfirmEnabled);
    loadLiveMode().then(setLiveEnabled);
    // Leaving the screen mid-sentence should not leave a voice talking to an
    // empty room — the synthesiser outlives the component otherwise. Same
    // reasoning for a conversation's open microphone, capturing or watching.
    return () => {
      stopSpeaking();
      conversationRecorderRef.current?.cancel();
      bargeInWatcherRef.current?.cancel();
      liveRef.current?.stop();
    };
  }, [refreshVehicle, refreshScheduled]);

  /** Silence it and settle the UI. Every route to "stop talking" goes through
   *  here, so the stop button can never outlive the speech it belongs to —
   *  including a live session, whose audio arrives on a socket the synthesiser
   *  knows nothing about. */
  const halt = useCallback(() => {
    stopSpeaking();
    liveRef.current?.interrupt();
    setSpeaking(false);
  }, []);

  // The end event is not guaranteed — Safari has been known to drop it, and a
  // browser with no audio device fires nothing while still reporting that it
  // is speaking. Polling the engine means the stop button always disappears
  // when there is nothing left to stop. The delay covers the opposite race:
  // the engine takes a moment to report `speaking` after being handed work.
  useEffect(() => {
    if (!speaking) return;
    // Not while a live session holds the conversation: its audio arrives on a
    // socket and plays through Web Audio, so the synthesiser it would ask
    // truthfully answers "not speaking" — and the stop button would vanish a
    // second into every spoken reply, while the reply carried on.
    if (liveRef.current) return;
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

  const changeLiveMode = useCallback((enabled: boolean) => {
    setLiveEnabled(enabled);
    saveLiveMode(enabled);
    // Takes effect on the next conversation rather than tearing down the one
    // in progress — switching transport mid-sentence would be worse than
    // finishing the exchange the old way.
  }, []);

  const changeVoiceConfirm = useCallback((enabled: boolean) => {
    setVoiceConfirmEnabled(enabled);
    saveVoiceConfirm(enabled);
    if (!enabled) awaitingVoiceConfirmRef.current = null;
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
    // A live session hears through its own socket rather than a watcher, so it
    // has to be told as well — the setting means the same thing there and must
    // apply to the conversation in progress, not the next one.
    if (liveRef.current) liveRef.current.allowBargeIn = enabled;
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

  /**
   * Keep the strip honest.
   *
   * A timer plus a wake-up, because on a phone the timer is the weaker half:
   * a backgrounded PWA has its intervals throttled to near-nothing, so coming
   * back to the app is exactly the moment the readings are most out of date and
   * the moment the interval is least likely to have just fired.
   */
  useEffect(() => {
    const timer = setInterval(refreshVehicle, VEHICLE_POLL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshVehicle();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [refreshVehicle]);

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

  const handleSend = useCallback(
    async (text: string, viaVoice?: boolean, conversationTurn?: boolean) => {
      setError(null);
      setFailed(null);
      // Asking something new retires the previous answer, spoken one included.
      halt();
      // Sending is an act of attention: whatever was being re-read, the answer
      // to this is what the driver now wants to see.
      atBottomRef.current = true;
      const rowId = id();
      setItems((prev) => [...prev, { kind: "message", id: rowId, role: "user", text }]);
      setPending(true);
      if (conversationTurn) setConversationPhase("thinking");
      try {
        const res = await sendMessage(text, history, language);
        const replyId = id();
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
                  args: call.input,
                  // Only during a conversation, and never for unlock — the
                  // server refuses that anyway, so offering it in the UI would
                  // just be a promise it won't keep.
                  voice:
                    conversationTurn &&
                    voiceConfirmEnabled &&
                    call.tool !== "unlock",
                },
              ];
            }
            return [row];
          }),
          { kind: "message", id: replyId, role: "assistant", text: res.reply },
        ]);
        setRevealId(replyId);
        // Arm the spoken confirmation for the newest parked command, if this
        // turn produced one. Last wins: if the assistant somehow proposed two,
        // the word is ambiguous and the server refuses it anyway.
        if (conversationTurn && voiceConfirmEnabled) {
          const parked = res.tool_trace
            .filter((call) => {
              const p = call.result as { confirm_token?: string } | undefined;
              return p?.confirm_token && call.tool !== "unlock";
            })
            .pop();
          const token = (parked?.result as { confirm_token?: string } | undefined)
            ?.confirm_token;
          awaitingVoiceConfirmRef.current =
            token && parked ? { token, tool: parked.tool } : null;
        }

        // Only the final reply is spoken — never the tool trace, and never a
        // pending confirmation as if it were the outcome. The model is already
        // told to say that something is waiting in the app (see
        // actions.propose), so that sentence is what gets read out.
        //
        // A conversation turn speaks regardless of the stored speech mode: a
        // voice conversation with a silent assistant makes no sense, and the
        // silence would also strand the loop with nothing to cue the next
        // listen.
        //
        // This is the typed assistant and the record-and-upload conversation
        // only. A live session is its own assistant with its own voice (see
        // voice/live.ts) and never routes anything through here — sending a
        // /chat reply down that socket to be read aloud is precisely the relay
        // design that made it hallucinate.
        if (
          conversationTurn ||
          speechMode === "always" ||
          (speechMode === "voice" && viaVoice)
        ) {
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
          // Keep the question, so the error bar can offer to ask it again. A
          // rate limit or a dropped signal is the ordinary case here, and
          // retyping a sentence you already said is a poor answer to it.
          setFailed({ text, viaVoice, rowId });
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

  // Only follows the conversation while the conversation is what's on screen.
  // Scrolled up to check what the assistant said two answers ago, the list used
  // to snap back to the bottom the moment anything arrived — including the
  // instrument-log lines a single turn appends one at a time.
  useEffect(() => {
    if (!items.length || !atBottomRef.current) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [items, pending]);

  /**
   * Keep the end of a reply in view while it is still uncovering itself.
   *
   * The reveal grows the row after the list has already settled, so the effect
   * above — which only runs when an item is added — would leave the last lines
   * of a long answer below the fold. Stops on its own once the reveal is over.
   */
  useEffect(() => {
    if (!revealId) return;
    const follow = setInterval(() => {
      if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
    }, 100);
    const done = setTimeout(() => {
      clearInterval(follow);
      setRevealId(null);
    }, REVEAL_FOLLOW_MS);
    return () => {
      clearInterval(follow);
      clearTimeout(done);
    };
  }, [revealId]);

  const speakAloud = useCallback(
    (line: string) => {
      // Whatever was being said is retired first, so tapping two replies in a
      // row does not leave two voices talking over each other.
      halt();
      primeSpeech();
      setSpeaking(true);
      speak(line, language, { onEnd: () => setSpeaking(false) });
    },
    [halt, language]
  );

  const handleRenameChat = useCallback((chatId: string, title: string) => {
    void renameChat(chatId, title).then(setChats);
  }, []);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const fromEnd = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const atBottom = fromEnd <= AT_BOTTOM_SLACK_PX;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    atBottomRef.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const retryFailed = useCallback(() => {
    if (!failed) return;
    const { text, viaVoice, rowId } = failed;
    setError(null);
    setFailed(null);
    // The question goes back on the end rather than staying where it was: it
    // was the last thing said, and handleSend appends it again.
    setItems((prev) => prev.filter((item) => item.id !== rowId));
    void handleSend(text, viaVoice);
  }, [failed, handleSend]);

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

  /**
   * Switch to a stored conversation.
   *
   * A running voice conversation belongs to the chat it started in, so it is
   * ended rather than carried across: its transcript would otherwise land in
   * whichever chat happened to be open when the driver stopped talking.
   */
  const openChat = async (chatId: string) => {
    setMenuOpen(false);
    if (chatId === activeChatId) return;
    const chat = await loadChat(chatId);
    if (!chat) {
      // The row outlived its body. Drop it rather than leaving a dead entry.
      setChats(await loadIndex());
      return;
    }
    stopConversationRef.current();
    halt();
    setError(null);
    skipSaveRef.current = true;
    setItems(chat.items);
    setHistory(chat.history);
    chatIdRef.current = chat.id;
    setActiveChatId(chat.id);
    void rememberLastChat(chat.id);
  };

  const startNewChat = () => {
    stopConversationRef.current();
    halt();
    setError(null);
    const fresh = newChatId();
    chatIdRef.current = fresh;
    setActiveChatId(fresh);
    setItems([]);
    setHistory([]);
    setMenuOpen(false);
    // Deliberately forgotten rather than pointed at the new one: an empty chat
    // is never written, so remembering its id would restore nothing and lose
    // the conversation that was actually last had.
    void rememberLastChat(null);
  };

  const removeChat = async (chatId: string) => {
    setChats(await deleteChat(chatId));
    if (chatId === activeChatId) startNewChat();
  };

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
    // Leaving the conversation retires the spoken shortcut; the card itself
    // stays on screen and stays tappable.
    awaitingVoiceConfirmRef.current = null;
    stopBargeInWatcher();
    conversationRecorderRef.current?.cancel();
    conversationRecorderRef.current = null;
    liveRef.current?.stop();
    liveRef.current = null;
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
    recorder.onLevel = reportLevel;
    recorder.onAutoStop = () => void finishConversationTurn();
    conversationRecorderRef.current = recorder;
    recorder.start().catch((e) => {
      // Permission refused or revoked, or the device took the microphone away
      // (a phone call arriving). Nothing left to listen with — and this has to
      // say so.
      //
      // It used to fail in silence, which is the whole of the bug where the
      // conversation button "does nothing": the bar appears for the length of
      // one failed getUserMedia and is gone again before anyone sees it, and
      // the driver is left tapping a control that gives no sign it was ever
      // pressed. A refused microphone is an ordinary thing to hit — it is a
      // browser permission, it is per-site, and Safari forgets it — so it is
      // worth a sentence rather than a shrug.
      conversationRecorderRef.current = null;
      const denied =
        e instanceof Error && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setError(
        denied
          ? t("voiceDenied")
          : t("voiceMicFailed", { reason: (e instanceof Error && e.name) || "?" })
      );
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

  /**
   * Offer this recording to the waiting card.
   *
   * Returns true when the turn is finished here — executed, cancelled, or
   * refused with something said about it — and false when the audio turned out
   * not to be an answer and should travel the ordinary path instead.
   *
   * The one case that deliberately does *not* fall through is a mis-hearing:
   * having asked to open the trunk, "no_match" almost always means the driver
   * said the word and it came back wrong, so sending that audio on to the
   * assistant as a fresh instruction would be the wrong guess to make.
   */
  const settleByVoice = async (
    awaiting: { token: string; tool: string },
    blob: Blob
  ): Promise<boolean> => {
    let outcome: string | undefined;
    try {
      const result = await confirmByVoice(blob, awaiting.token, language);
      if (result.ok) {
        awaitingVoiceConfirmRef.current = null;
        emptyTurnsRef.current = 0;
        setItems((prev) => [
          ...prev,
          { kind: "message", id: id(), role: "assistant", text: t("confirmExecuted") },
        ]);
        refreshVehicle();
        refreshScheduled();
        speakThen(t("confirmExecuted"));
        return true;
      }
      outcome = result.outcome;
    } catch {
      // The card stays on screen and stays tappable, which is the fallback
      // this whole feature is layered on top of.
      awaitingVoiceConfirmRef.current = null;
      listenAgain();
      return true;
    }

    if (outcome === "cancelled") {
      awaitingVoiceConfirmRef.current = null;
      setItems((prev) => [
        ...prev,
        { kind: "message", id: id(), role: "assistant", text: t("confirmDismissed") },
      ]);
      speakThen(t("confirmDismissed"));
      return true;
    }
    if (outcome === "no_speech") {
      // Nothing was said. Keep the card armed and keep listening — this costs
      // no attempt server-side either.
      listenAgain();
      return true;
    }
    // Heard, but not the word. One nudge, then the card is tap-only.
    awaitingVoiceConfirmRef.current = null;
    setItems((prev) => [
      ...prev,
      { kind: "message", id: id(), role: "assistant", text: t("voiceConfirmMissed") },
    ]);
    speakThen(t("voiceConfirmMissed"));
    return true;
  };

  /** Speak a line the assistant produced locally, then carry on listening. */
  const speakThen = (line: string) => {
    setSpeaking(true);
    setConversationPhase("speaking");
    startBargeInWatcherRef.current();
    speak(line, language, {
      onEnd: () => {
        setSpeaking(false);
        stopBargeInWatcherRef.current();
        listenAgainRef.current();
      },
    });
  };

  const finishConversationTurn = async () => {
    const recorder = conversationRecorderRef.current;
    if (!recorder) return;
    conversationRecorderRef.current = null;
    setConversationPhase("thinking");
    try {
      const blob = await recorder.stop();

      // A card is waiting: this turn is an answer to it, not a new request.
      // The audio goes to the confirmation route and never to the model, so
      // "potwierdzam" cannot also be read as an instruction.
      const awaiting = awaitingVoiceConfirmRef.current;
      if (awaiting) {
        const settled = await settleByVoice(awaiting, blob);
        if (settled) return;
        // Not a confirmation after all — fall through and treat it as an
        // ordinary thing the driver said.
      }

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
        // spin through the same failure every couple of seconds, and say why,
        // or ending mid-conversation looks like the app losing interest.
        setError(e instanceof BackendError ? e.message : t("voiceFailed"));
        stopConversation();
      }
    }
  };

  /**
   * Open a live session, or say why not.
   *
   * Falling back rather than failing is the whole point: a refused token, a
   * blocked socket or a flaky tunnel drops the conversation onto the
   * record-and-upload path that has been working all along, and the driver
   * hears a slightly slower assistant instead of none.
   *
   * What comes back through these handlers is a conversation that already
   * happened — the live assistant heard the question, called the tools and
   * answered out loud on its own. Nothing here sends anything to /chat: the
   * two assistants keep separate contexts on purpose, and the only things they
   * share are the tool list, the confirmation gate, and this transcript.
   */
  const startLive = async (): Promise<boolean> => {
    if (!liveEnabled || !liveSupported() || voiceChoice === "device") return false;
    const session = new LiveSession({
      onLevel: reportLevel,
      onPhase: (phase) => {
        if (!conversationActiveRef.current) return;
        setConversationPhase(phase);
        setSpeaking(phase === "speaking");
      },
      onUserTranscript: (text, audio) => {
        // Two transcripts of the same words, shown in the order they arrive.
        //
        // The session's own is instant and blind — a general recogniser with no
        // language, no vocabulary and no context, which is why "Supercharger"
        // came out as "super czarny". It goes up straight away so the row
        // appears while the assistant is already answering.
        //
        // Then the same audio goes to /voice/transcribe, which knows the
        // language and the car's vocabulary, and the row is quietly corrected
        // in place. One extra request per spoken turn, on its own daily budget
        // (GEMINI_TRANSCRIBE_MODEL), and purely cosmetic: the assistant heard
        // the audio itself and has already acted. If this fails — no signal, a
        // spent quota — the first transcript simply stays, which is exactly
        // what was there before.
        const rowId = id();
        setItems((prev) => [
          ...prev,
          { kind: "message", id: rowId, role: "user", text, heard: true },
        ]);
        if (!audio) return;
        void transcribe(audio, language)
          .then((better) => {
            const clean = better.trim();
            if (!clean || clean === text) return;
            setItems((prev) =>
              prev.map((item) =>
                item.kind === "message" && item.id === rowId
                  ? { ...item, text: clean }
                  : item
              )
            );
          })
          .catch(() => {
            // The heard-it-roughly version is the fallback, and it is already
            // on screen.
          });
      },
      onAssistantTranscript: (text) => {
        setItems((prev) => [...prev, { kind: "message", id: id(), role: "assistant", text }]);
      },
      onTool: ({ tool, args, ok, confirm }) => {
        setItems((prev) => [
          ...prev,
          { kind: "tool", id: id(), call: { tool, input: args, ok } },
          // Parked rather than executed. The card is the only way it runs, and
          // it is tap-only: settling one by voice needs a recording sent to
          // /actions/confirm/voice, and in a live session the audio belongs to
          // the socket. Saying "confirm" here would reach the model, not the
          // gate — which is the one thing that must never be true of that word.
          ...(confirm
            ? [
                {
                  kind: "confirm" as const,
                  id: id(),
                  token: confirm.token,
                  tool: confirm.tool,
                  args: confirm.args,
                  voice: false,
                },
              ]
            : []),
        ]);
        if (ok && !confirm) {
          // Something actually changed in the car — show it without waiting
          // for the next poll.
          refreshVehicle();
          refreshScheduled();
        }
      },
      onIdle: () => {
        // Nobody has said anything for a while. A phone left in a parked car
        // must not hold the microphone open until the token expires.
        stopConversation();
      },
      onClosed: () => {
        // Release the microphone first and unconditionally. This fires for a
        // session that never became the current one too — a socket refused
        // just after it opened — and skipping the release in that case is how
        // a stream stayed live with nothing holding it, leaving the browser
        // showing the tab as recording long after the conversation had
        // visibly ended. stop() is idempotent, so saying it twice costs
        // nothing and forgetting it once costs the microphone.
        session.stop();
        if (liveRef.current !== session) return;
        liveRef.current = null;
        // Gone mid-conversation: drop to the old path rather than ending the
        // exchange the driver is in the middle of.
        if (conversationActiveRef.current) listenAgain();
      },
    });
    session.allowBargeIn = bargeInEnabled;
    try {
      await session.start(voiceChoice, language);
      // Opening a session takes a network round trip for the token and then a
      // permission-gated getUserMedia, and the conversation can be over before
      // either finishes — the driver taps start, changes their mind, taps end.
      // stopConversation ran while liveRef was still null, so it found nothing
      // to stop; without this check the session would arrive a moment later
      // holding an open microphone and a live socket, with the UI already
      // showing the conversation as ended and no route left that would ever
      // close it. That is what left the browser's recording indicator lit.
      if (!conversationActiveRef.current) {
        session.stop();
        return true; // handled: no fallback, there is no conversation to have
      }
      liveRef.current = session;
      return true;
    } catch {
      session.stop();
      return false;
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
    setConversationPhase("listening");
    // Try the live session first; listenAgain is the fallback and also the
    // path when live is switched off.
    void startLive().then((live) => {
      if (!live && conversationActiveRef.current) listenAgain();
    });
  };

  const handleConversationTap = () => {
    // A live session decides for itself when the driver has finished talking,
    // so the tap only means one thing there: stop answering. Tapping while it
    // listens is a no-op rather than an early "I'm done" — asking the model to
    // close a turn it did not think was over is what used to make it answer
    // out of turn.
    if (liveRef.current) {
      if (conversationPhase === "speaking") liveRef.current.interrupt();
      return;
    }
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

  const sidebarProps = {
    chats,
    activeChatId,
    onOpenChat: (chatId: string) => void openChat(chatId),
    onDeleteChat: (chatId: string) => void removeChat(chatId),
    onRenameChat: handleRenameChat,
    onNewChat: startNewChat,
    actions: scheduled,
    onCancelAction: handleCancelAction,
    onOpenSettings: () => {
      setMenuOpen(false);
      setShowSettings(true);
    },
    onLock: () => {
      setMenuOpen(false);
      // Stops the conversation's open microphone too, not just any speech — a
      // locked app listening in the background would be a strange thing to
      // discover.
      stopConversation();
      lock().finally(() => onLocked?.());
    },
  };

  return (
    // Top only. The bottom inset is the input bar's own business now (see
    // ChatInput): applied here as well, the two stacked — the safe area's
    // clearance for the home indicator *plus* the bar's own padding — and the
    // bar floated well above the bottom of the screen.
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Two shapes of the same screen. On a phone the drawer is an overlay and
          the chat has the width to itself. Given a laptop's worth of room, the
          drawer becomes a column that is simply there, and the chat stops
          growing at a readable measure instead of stretching a sentence across
          fourteen hundred points. */}
      <View style={styles.layout}>
        {wide && <Sidebar docked open onClose={() => {}} {...sidebarProps} />}
        <View style={styles.flex}>
          <InstrumentStrip
            state={vehicle}
            onDisconnect={onDisconnect}
            // No menu button when the menu is already on screen.
            onOpenMenu={
              wide
                ? undefined
                : () => {
                    refreshScheduled();
                    setMenuOpen(true);
                  }
            }
            activeActionCount={activeActions.length}
          />
          <KeyboardAvoidingView
            style={[styles.flex, wide && styles.readingColumn]}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
          >
            <FlatList
              ref={listRef}
              data={items}
              keyExtractor={(item) => item.id}
              contentContainerStyle={[
                styles.listContent,
                items.length === 0 && styles.listContentEmpty,
              ]}
              onScroll={handleScroll}
              scrollEventThrottle={16}
              renderItem={({ item, index }) =>
                item.kind === "message" ? (
                  <MessageRow
                    role={item.role}
                    text={item.text}
                    heard={item.heard}
                    // The rail runs into a reply only when the turn above it
                    // actually touched the car.
                    attached={items[index - 1]?.kind === "tool"}
                    showActions={index === items.length - 1 && !pending}
                    reveal={item.id === revealId}
                    onSpeak={
                      item.role === "assistant" ? () => speakAloud(item.text) : undefined
                    }
                    onResend={
                      item.role === "user" ? () => void handleSend(item.text) : undefined
                    }
                  />
                ) : item.kind === "confirm" ? (
                  <ConfirmCard
                    token={item.token}
                    tool={item.tool}
                    args={item.args}
                    voice={item.voice}
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
              // Derived at render rather than stored, which also retires the
              // effect that used to re-translate the greeting when the language
              // changed: there is nothing to re-translate when nothing was ever
              // saved.
              // The greeting is a placeholder, not a message: it was once a real
              // assistant turn, which made a brand-new chat look like one
              // already in progress and saved the same line into every stored
              // conversation.
              ListEmptyComponent={
                pending ? null : (
                  <View style={styles.opening}>
                    <Text style={styles.openingGreeting}>{opening.greeting}</Text>
                    <Text style={styles.openingQuestion}>
                      {justConnected ? t("connectedGreeting") : opening.question}
                    </Text>
                    <SuggestionChips onPick={(text) => void handleSend(text)} />
                  </View>
                )
              }
            />
            {/* Only while the latest is out of sight. It is the way back from
                reading history, and the reason the list no longer drags the
                view down on its own. */}
            {showJump && (
              <Pressable
                onPress={jumpToLatest}
                accessibilityRole="button"
                accessibilityLabel={t("scrollToLatest")}
                style={({ pressed }) => [styles.jump, pressed && styles.jumpPressed]}
              >
                <IconChevronDown size={16} color={color.textSecondary} />
              </Pressable>
            )}
            {error && (
              <View style={styles.errorBar}>
                <Text style={styles.errorText}>{error}</Text>
                {failed && (
                  <Pressable
                    onPress={retryFailed}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.errorButton, pressed && styles.pressedText]}
                  >
                    <Text style={styles.errorAction}>{t("errorRetry")}</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => {
                    setError(null);
                    setFailed(null);
                  }}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t("errorDismiss")}
                  style={({ pressed }) => [styles.errorButton, pressed && styles.pressedText]}
                >
                  <IconClose size={12} color={color.alert} />
                </Pressable>
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
        </View>
      </View>

      {/* Opens the drawer with a drag from the left edge, the way every other
          app on the phone does — the menu button stays, this is the gesture
          for a hand already holding the phone.

          Sixteen points wide and only present while the drawer is shut. That
          strip is the chat list's own padding, so nothing tappable lives under
          it; a taller catcher would start eating the left edge of messages.

          Nothing to pull in when the drawer is already a column, so on a wide
          screen the gesture — and the browser's back-swipe it has to fight — is
          simply left alone. */}
      {!wide && !menuOpen && (
        <View
          ref={edgeRef}
          style={styles.edgeCatcher}
          {...edgeSwipe.panHandlers}
          pointerEvents="auto"
        />
      )}

      {!wide && (
        <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} {...sidebarProps} />
      )}

      {/* Over the chat rather than instead of it. As an early return this
          unmounted the transcript, so closing Settings dropped the reader back
          at the bottom of a list they may have been halfway up. */}
      {showSettings && (
        <View style={StyleSheet.absoluteFill}>
          <SettingsScreen
            onClose={() => setShowSettings(false)}
            speechMode={speechMode}
            onSpeechModeChange={changeSpeechMode}
            voiceChoice={voiceChoice}
            onVoiceChange={changeVoice}
            bargeInEnabled={bargeInEnabled}
            onBargeInChange={changeBargeIn}
            voiceConfirmEnabled={voiceConfirmEnabled}
            onVoiceConfirmChange={changeVoiceConfirm}
            liveEnabled={liveEnabled}
            onLiveChange={changeLiveMode}
          />
        </View>
      )}
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
  layout: {
    flex: 1,
    flexDirection: "row",
  },
  readingColumn: {
    width: "100%",
    maxWidth: READING_WIDTH,
    alignSelf: "center",
  },
  listContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  /** Nothing said yet. The opening sits low, just above the composer, rather
   *  than floating in the middle of the screen: the greeting and the thing you
   *  are about to type into belong together, and the eye should not have to
   *  travel between them. */
  listContentEmpty: {
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  opening: {
    paddingBottom: space.xl,
  },
  openingGreeting: {
    ...type.hero,
    color: color.textPrimary,
  },
  openingQuestion: {
    ...type.hero,
    color: color.textTertiary,
  },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.alertSoft,
    borderWidth: 1,
    borderColor: color.alert,
  },
  errorButton: {
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
  },
  errorAction: {
    ...type.label,
    fontFamily: font.bodySemiBold,
    color: color.alert,
  },
  pressedText: {
    opacity: 0.55,
  },
  jump: {
    alignSelf: "center",
    marginBottom: space.sm,
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  jumpPressed: {
    backgroundColor: color.surfaceHover,
  },
  edgeCatcher: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 16,
  },
  errorText: {
    flex: 1,
    ...type.caption,
    color: color.alert,
  },
});
