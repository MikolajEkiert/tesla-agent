/**
 * Conversations that outlive the tab.
 *
 * Until now a refresh was amnesia: the transcript lived in React state and the
 * assistant's own context died with it, so reloading the page in a car — which
 * happens on its own, when the phone reclaims memory from a backgrounded PWA —
 * lost the exchange in progress. This keeps both halves: what you can see, and
 * what the model remembers.
 *
 * Two keys rather than one blob. The sidebar only needs titles and times, and
 * a chat body carries whole tool results (vehicle state, lists of chargers)
 * which run to tens of kilobytes — parsing all of them on boot to draw a list
 * of six lines would be paid on every launch. So an index is stored on its
 * own, and a body is read only when a chat is opened.
 *
 * On web AsyncStorage *is* localStorage, which is what this was asked for; on
 * native it is the platform's own store. Same code either way.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatItem } from "./types";

const INDEX_KEY = "amp.chats.index";
const BODY_PREFIX = "amp.chat.";
const LAST_KEY = "amp.chats.last";

/** Conversations kept before the oldest is dropped. Generous for a personal
 *  assistant and still far inside a 5 MB store, given the cap below. */
const MAX_CHATS = 25;

/** Turns kept in one conversation. Mirrors MAX_HISTORY_TURNS in
 *  backend/app/llm/prompt.py, which trims the same history server-side — there
 *  is no point storing what the assistant will never be sent. */
const MAX_TURNS = 60;

/** Visible rows kept. Higher than MAX_TURNS because one turn can produce
 *  several rows: the message, a line per tool call. */
const MAX_ITEMS = 240;

/** Characters of the first thing said, kept as the name of the chat. */
const MAX_TITLE = 60;

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** The owner named this one. Saving must then stop deriving a title from the
   *  first thing they said, or the next keystroke would overwrite the name. */
  renamed?: boolean;
}

export interface StoredChat extends ChatSummary {
  items: ChatItem[];
  /** Provider-native history, exactly as the backend returned it. Opaque here
   *  on purpose: this module stores it, it does not interpret it. */
  history: Record<string, unknown>[];
}

export function newChatId(): string {
  // Enough to not collide across a session's worth of chats, and no attempt at
  // being unguessable — these never leave the device.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A name for the conversation, taken from the first thing the owner said.
 *
 * The greeting is skipped deliberately: every chat opens with the same one, so
 * naming them after it would produce a list of identical rows.
 */
export function titleFor(items: ChatItem[]): string {
  // The driver's own words when there are any. A spoken conversation has none:
  // its turns are durations now, not transcripts, and "Mówiłeś przez 4
  // sekundy" would name every voice chat the same nonsense. So those fall back
  // to the first thing the assistant said, which is about the same subject and
  // is at least a sentence somebody meant.
  const first =
    items.find((item) => item.kind === "message" && item.role === "user") ??
    items.find((item) => item.kind === "message" && item.role === "assistant");
  if (!first || first.kind !== "message") return "";
  const text = first.text.trim().replace(/\s+/g, " ");
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}

/**
 * Whether there is anything worth keeping.
 *
 * A chat holding only the opening greeting is not a conversation, and saving
 * one would fill the sidebar with empty rows every time the app was opened and
 * closed again.
 */
export function isWorthSaving(items: ChatItem[]): boolean {
  // A spoken turn counts. It carries no text — see the "voice" item in
  // types.ts — so a conversation held entirely by voice has no user message in
  // it at all, and testing for one would have thrown away every live
  // conversation the moment it ended.
  return items.some(
    (item) => item.kind === "voice" || (item.kind === "message" && item.role === "user")
  );
}

/**
 * Strip what must not come back.
 *
 * A confirmation card carries a token the server forgets after two minutes, so
 * a restored one is a button that can only fail — and worse, it looks live. The
 * tool line above it survives, so the record of what was proposed is still
 * there; only the pretence that it is still tappable goes.
 */
function forStorage(items: ChatItem[]): ChatItem[] {
  return items.filter((item) => item.kind !== "confirm").slice(-MAX_ITEMS);
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Unparseable or unavailable. A corrupt entry must not stop the app
    // opening; it reads as "no history", which is recoverable.
    return null;
  }
}

export async function loadIndex(): Promise<ChatSummary[]> {
  const index = await readJson<ChatSummary[]>(INDEX_KEY);
  if (!Array.isArray(index)) return [];
  return index
    .filter((entry) => entry && typeof entry.id === "string")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadChat(id: string): Promise<StoredChat | null> {
  const chat = await readJson<StoredChat>(BODY_PREFIX + id);
  if (!chat || !Array.isArray(chat.items)) return null;
  return { ...chat, history: Array.isArray(chat.history) ? chat.history : [] };
}

export async function loadLastChatId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export async function rememberLastChat(id: string | null): Promise<void> {
  try {
    if (id) await AsyncStorage.setItem(LAST_KEY, id);
    else await AsyncStorage.removeItem(LAST_KEY);
  } catch {
    // Best effort: losing this means the next launch opens a fresh chat.
  }
}

/**
 * Write a conversation and bring it to the top of the list.
 *
 * Quota is handled rather than hoped about: a store that refuses a write is
 * the normal end state of an app that keeps transcripts, not an exceptional
 * one. The oldest chat is dropped and the write retried, until it fits or
 * there is nothing left to drop — at which point the save is abandoned
 * silently, because a chat that cannot be saved is not a reason to interrupt
 * the one being had.
 */
export async function saveChat(chat: StoredChat): Promise<ChatSummary[]> {
  // A name the owner typed outranks one derived from the transcript, and the
  // caller does not have to know which is which.
  const existing = (await loadIndex()).find((entry) => entry.id === chat.id);
  const summary: ChatSummary = {
    id: chat.id,
    title: existing?.renamed ? existing.title : chat.title || titleFor(chat.items),
    updatedAt: chat.updatedAt,
    renamed: existing?.renamed,
  };
  const body: StoredChat = {
    ...summary,
    items: forStorage(chat.items),
    history: chat.history.slice(-MAX_TURNS),
  };

  let index = [summary, ...(await loadIndex()).filter((entry) => entry.id !== chat.id)];
  for (const dropped of index.slice(MAX_CHATS)) {
    await removeBody(dropped.id);
  }
  index = index.slice(0, MAX_CHATS);

  while (true) {
    try {
      await AsyncStorage.setItem(BODY_PREFIX + body.id, JSON.stringify(body));
      await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
      return index;
    } catch {
      // Full. Drop the oldest chat that is not the one being written.
      const victim = [...index].reverse().find((entry) => entry.id !== body.id);
      if (!victim) return index;
      await removeBody(victim.id);
      index = index.filter((entry) => entry.id !== victim.id);
    }
  }
}

/**
 * Give a conversation a name of its own.
 *
 * Written to the index and to the body, because the body is what a later save
 * reads back — and marked as deliberate, so `saveChat` stops replacing it with
 * the first sentence of the transcript. An empty name hands the chat back to
 * that automatic title rather than leaving a blank row.
 */
export async function renameChat(id: string, title: string): Promise<ChatSummary[]> {
  const clean = title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE);
  const body = await loadChat(id);
  // Cleared rather than renamed: hand the chat back to its automatic title.
  const resolved = clean || (body ? titleFor(body.items) : "");
  const renamed = clean.length > 0;

  const index = (await loadIndex()).map((entry) =>
    entry.id === id ? { ...entry, title: resolved || entry.title, renamed } : entry
  );
  try {
    if (body) {
      await AsyncStorage.setItem(
        BODY_PREFIX + id,
        JSON.stringify({ ...body, title: resolved, renamed })
      );
    }
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Storage refused the write; the row keeps the name it had.
  }
  return index;
}

async function removeBody(id: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(BODY_PREFIX + id);
  } catch {
    // Nothing to do — the index no longer points at it either way.
  }
}

export async function deleteChat(id: string): Promise<ChatSummary[]> {
  await removeBody(id);
  const index = (await loadIndex()).filter((entry) => entry.id !== id);
  try {
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // The body is already gone, so the worst case is a row pointing at
    // nothing — loadChat returns null and the app opens a fresh chat.
  }
  const last = await loadLastChatId();
  if (last === id) await rememberLastChat(null);
  return index;
}
