/**
 * The small amount of Markdown a chat model actually emits, understood once.
 *
 * The assistant has always written `**Pani Pasta**` when it lists something;
 * nothing ever read that, so the chat showed the asterisks and — worse, because
 * it is harder to notice — the synthesiser read them out loud. Both are the
 * same missing step, so it lives in one file and both callers use it: the
 * renderer (components/RichText.tsx) and the speech path (voice/speak.ts).
 *
 * Deliberately a fraction of Markdown. There is no HTML, no tables, no links,
 * no images — a car assistant answering out loud has no use for any of it, and
 * every construct understood here is one that can also be got wrong.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type Block =
  | { kind: "blank" }
  | { kind: "heading"; spans: Span[] }
  | { kind: "bullet"; spans: Span[] }
  | { kind: "text"; spans: Span[] };

/**
 * Bold, italic and code, and nothing else.
 *
 * `__bold__` and `_italic_` are left out on purpose, though a Markdown parser
 * would take them: this assistant talks about `get_vehicle_state` and
 * `set_charge_limit`, and underscores inside a name would turn half a tool
 * into italics. Asterisks do not appear in the middle of words the same way.
 */
const TOKEN = /\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*/g;

function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const match of line.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    if (start > at) spans.push({ text: line.slice(at, start) });
    const raw = match[0];
    if (raw.startsWith("**")) {
      spans.push({ text: raw.slice(2, -2), bold: true });
    } else if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), code: true });
    } else {
      spans.push({ text: raw.slice(1, -1), italic: true });
    }
    at = start + raw.length;
  }
  if (at < line.length) spans.push({ text: line.slice(at) });
  return spans.length ? spans : [{ text: line }];
}

export function parseBlocks(text: string): Block[] {
  return text.split("\n").map((line): Block => {
    if (!line.trim()) return { kind: "blank" };

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) return { kind: "heading", spans: parseSpans(heading[1]) };

    // A numbered list keeps its number — "3." carries meaning in "the third
    // best rated" in a way a bullet does not, and the model chose to number it.
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) return { kind: "bullet", spans: parseSpans(bullet[1]) };

    return { kind: "text", spans: parseSpans(line) };
  });
}

/**
 * The same text with the marks taken off, for a voice to read.
 *
 * Bullets lose their dash rather than gaining a "•" — a synthesiser reads that
 * glyph aloud in some languages, and a list read to a driver does not need its
 * punctuation announced. Line breaks become full stops so the reader pauses
 * where the list did, instead of running five restaurants into one sentence.
 */
export function toPlainText(text: string): string {
  const lines = parseBlocks(text).map((block) => {
    if (block.kind === "blank") return "";
    const joined = block.spans.map((span) => span.text).join("");
    return joined.trim();
  });

  const out: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    out.push(/[.!?:,;]$/.test(line) ? line : `${line}.`);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}
