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
  /** Also what is sent as `persona`. Random rather than derived from the name,
   *  so renaming one later cannot collide with another. */
  id: string;
  name: string;
  /** The owner's description of how to sound, sent as `persona_style`. */
  style: string;
}

const SELECTED_KEY = "amp.persona";
const CUSTOM_KEY = "amp.personas.custom";

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

function newPersonaId(): string {
  // Unique enough for a dozen entries on one device, and deliberately not
  // unguessable — these are labels for a prompt, not credentials.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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

export async function loadCustomPersonas(): Promise<CustomPersona[]> {
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

async function saveCustomPersonas(personas: CustomPersona[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(personas));
  } catch {
    // best-effort persistence only
  }
}

/**
 * Add one, and return the list as it now stands.
 *
 * Trimming happens here rather than at the input, so what is stored is what
 * will be sent: a name of only whitespace is not a name, and a style note is
 * capped at the same length the server would cap it at anyway.
 */
export async function addCustomPersona(
  name: string,
  style: string
): Promise<CustomPersona[]> {
  const persona: CustomPersona = {
    id: newPersonaId(),
    name: name.trim().slice(0, MAX_NAME_CHARS),
    style: style.trim().slice(0, MAX_STYLE_CHARS),
  };
  const existing = await loadCustomPersonas();
  const next = [...existing, persona].slice(-MAX_CUSTOM_PERSONAS);
  await saveCustomPersonas(next);
  return next;
}

export async function updateCustomPersona(
  id: string,
  name: string,
  style: string
): Promise<CustomPersona[]> {
  const next = (await loadCustomPersonas()).map((p) =>
    p.id === id
      ? {
          ...p,
          name: name.trim().slice(0, MAX_NAME_CHARS),
          style: style.trim().slice(0, MAX_STYLE_CHARS),
        }
      : p
  );
  await saveCustomPersonas(next);
  return next;
}

export async function deleteCustomPersona(id: string): Promise<CustomPersona[]> {
  const next = (await loadCustomPersonas()).filter((p) => p.id !== id);
  await saveCustomPersonas(next);
  return next;
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
