/**
 * The manner the assistant answers in — and the owner's own additions to it.
 *
 * Four come built in and are named by id only; their labels are translated in
 * i18n.ts and their actual instructions live server-side in
 * backend/app/llm/persona.py. That split is deliberate: the ids are the wire
 * format, so they must agree across both halves, while the wording of a style
 * note is a prompt and belongs next to the prompt it joins.
 *
 * The ones the owner writes never leave the device except as the text of a
 * single request. There is no account and no sync here — the server holds no
 * per-user state at all — so a custom persona is stored beside the language
 * and the voice, and travels with each message that uses it. The upshot worth
 * knowing: a persona created on the phone does not exist on the laptop, and
 * selecting one that has been deleted quietly falls back to the standard
 * manner rather than failing (see backend `resolve`).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  deleteCustomPersona as removeCustomPersona,
  fetchPersonas,
  saveCustomPersona,
} from "./api";
import type { TranslationKey } from "./i18n";

/** Kept in step with PERSONAS in backend/app/llm/persona.py. An id here that
 *  the server does not know is not an error — it is read as a custom persona
 *  with no style text, which is the standard manner — so drift shows up as a
 *  setting that quietly does nothing, and is worth avoiding by hand. */
export const BUILT_IN_PERSONAS = ["standard", "youth", "vulgar", "elegant"] as const;

export type PersonaId = string;

export const DEFAULT_PERSONA: PersonaId = "standard";

/** Mirrors MAX_CUSTOM_CHARS in backend/app/llm/persona.py, which enforces it
 *  regardless. Held here too so the limit is met while typing rather than
 *  applied silently to something already written.
 *
 *  A mirror is a thing that drifts: this said 600 while the server had moved to
 *  1600, so the field stopped accepting text the server would have taken. The
 *  server already publishes the real number as `max_style_chars` on /personas —
 *  nothing reads it yet, which is exactly why the two numbers were free to part
 *  company. Change both together until something does. */
export const MAX_STYLE_CHARS = 1600;

/** A chip in a settings grid, not a title. */
export const MAX_NAME_CHARS = 24;

/** How many of their own the owner may keep. High enough never to be met in
 *  practice, low enough that the picker stays a grid you can read at a glance
 *  rather than a list you scroll in a car. */
export const MAX_CUSTOM_PERSONAS = 12;

export interface CustomPersona {
  /** Also what is sent as `persona`. Minted by the server, which is where
   *  these live — see backend/app/persona_store.py. */
  id: string;
  name: string;
  /** The owner's description of how to sound, sent as `persona_style`. */
  style: string;
}

const SELECTED_KEY = "amp.persona";
const CUSTOM_KEY = "amp.personas.custom";
/** Set once this device has handed its own manners to the server. */
const MIGRATED_KEY = "amp.personas.migrated";

export const BUILT_IN_LABELS: Record<string, TranslationKey> = {
  standard: "personaStandard",
  youth: "personaYouth",
  vulgar: "personaVulgar",
  elegant: "personaElegant",
};

export const BUILT_IN_HINTS: Record<string, TranslationKey> = {
  standard: "personaStandardHint",
  youth: "personaYouthHint",
  vulgar: "personaVulgarHint",
  elegant: "personaElegantHint",
};

export function isBuiltIn(id: PersonaId): boolean {
  return (BUILT_IN_PERSONAS as readonly string[]).includes(id);
}

export async function loadPersona(): Promise<PersonaId> {
  try {
    const stored = await AsyncStorage.getItem(SELECTED_KEY);
    if (stored) return stored;
  } catch {
    // storage unavailable — the default manner is a fine answer
  }
  return DEFAULT_PERSONA;
}

export async function savePersona(id: PersonaId): Promise<void> {
  try {
    await AsyncStorage.setItem(SELECTED_KEY, id);
  } catch {
    // best-effort persistence only
  }
}

/**
 * The owner's manners, from the server, with the device's copy as a fallback.
 *
 * The server is where they live now (backend/app/persona_store.py): one list
 * for the laptop and the phone, surviving a cleared browser store and a
 * redeploy. What is kept here is a cache of that list, and it exists for one
 * job — drawing the picker when the car has no signal. It is never the version
 * that gets written to.
 *
 * A device that still holds manners from before they were kept server-side
 * hands them over on the way past, ids and all, so one that was already
 * selected stays selected. That runs once and then the local copy is only ever
 * a mirror; a manner deleted on the laptop does not come back from the phone.
 */
export async function loadCustomPersonas(): Promise<CustomPersona[]> {
  const cached = await readCache();
  try {
    const { custom } = await fetchPersonas();
    let list = custom;
    const missing = cached.filter((local) => !custom.some((p) => p.id === local.id));
    if (missing.length && !(await migrationDone())) {
      for (const persona of missing) {
        try {
          list = await saveCustomPersona(persona.name, persona.style, persona.id);
        } catch {
          // One that will not go up — too many, or empty after the server's
          // own trimming — must not stop the others.
        }
      }
    }
    await markMigrated();
    await writeCache(list);
    return list;
  } catch {
    // No signal, or the session has lapsed. The cache is what the picker had
    // last time, which is better than an empty settings screen.
    return cached;
  }
}

async function readCache(): Promise<CustomPersona[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filtered rather than trusted: this is JSON from a store the user's own
    // browser owns, and one malformed entry should cost that entry, not the
    // whole list.
    return parsed.filter(
      (p: unknown): p is CustomPersona =>
        !!p &&
        typeof (p as CustomPersona).id === "string" &&
        typeof (p as CustomPersona).name === "string" &&
        typeof (p as CustomPersona).style === "string"
    );
  } catch {
    return [];
  }
}

async function writeCache(personas: CustomPersona[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(personas));
  } catch {
    // best-effort persistence only
  }
}

/** Whether this device has already handed its own manners over. Without it, a
 *  manner deleted on another device would be re-uploaded by this one on every
 *  load, and deleting anything would become impossible. */
async function migrationDone(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(MIGRATED_KEY)) === "1";
  } catch {
    return false;
  }
}

async function markMigrated(): Promise<void> {
  try {
    await AsyncStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    // A device that cannot remember will re-offer what it holds, which the
    // server takes as an update to the same ids. Harmless, just wasteful.
  }
}

/**
 * Write one, and return the list as it now stands.
 *
 * Trimming is the server's job now and it does it in one place, so what comes
 * back is what a request will actually use. Passing an id overwrites; leaving
 * it out creates.
 */
export async function addCustomPersona(
  name: string,
  style: string
): Promise<CustomPersona[]> {
  const list = await saveCustomPersona(name.trim(), style.trim());
  await writeCache(list);
  return list;
}

export async function updateCustomPersona(
  id: string,
  name: string,
  style: string
): Promise<CustomPersona[]> {
  const list = await saveCustomPersona(name.trim(), style.trim(), id);
  await writeCache(list);
  return list;
}

export async function deleteCustomPersona(id: string): Promise<CustomPersona[]> {
  const list = await removeCustomPersona(id);
  await writeCache(list);
  return list;
}

/**
 * What to put on the wire for the persona currently chosen.
 *
 * One place decides this because three callers need the same answer — the chat
 * request, the live-token request, and any retry of either — and a custom
 * persona is only meaningful when its text travels with its id. A selected
 * persona that no longer exists (deleted here, or created on another device)
 * sends the id alone, which the server reads as the standard manner.
 */
export function personaFields(
  id: PersonaId,
  custom: CustomPersona[]
): { persona: string; personaStyle?: string } {
  if (isBuiltIn(id)) return { persona: id };
  const found = custom.find((p) => p.id === id);
  return found ? { persona: id, personaStyle: found.style } : { persona: id };
}

/** The name to show for an id, given what the app knows. Built-ins are
 *  translated by the caller (they hold `t`); custom ones carry their own name.
 *  Null means "no such persona", which the picker draws as nothing selected. */
export function customName(id: PersonaId, custom: CustomPersona[]): string | null {
  return custom.find((p) => p.id === id)?.name ?? null;
}
