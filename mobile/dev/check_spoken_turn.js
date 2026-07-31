/**
 * A spoken turn is now a length, not a quotation. Does the length mean
 * anything, and does it read as Polish?
 *
 * Two things are being protected, and both are the kind that break quietly.
 *
 * The measurement. The buffer a turn is measured from is the whole listening
 * window — the microphone is open from the moment the assistant stops talking
 * — so its own length is not an answer: a driver who waits, says "tak", and
 * waits again did not speak for eight seconds. speechSpanMs looks for the span
 * between the first and last speech-shaped block, at the thresholds vad.ts
 * measured for the recorder.
 *
 * The wording. Polish declines the noun three ways and the teens are
 * exceptions, so a plural rule that looks right for 1, 2 and 5 can still say
 * "22 sekund" and "12 sekundy". Every boundary is listed below rather than
 * sampled.
 *
 * Network-free and model-free: transpiled sources with their imports stubbed,
 * like dev/check_live_end.js beside it.
 *
 * Run from mobile/:  node dev/check_spoken_turn.js
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join(process.cwd(), "node_modules/typescript"));

function load(relative, stubs = {}) {
  const js = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", js)((name) => stubs[name] ?? {}, mod, mod.exports);
  return mod.exports;
}

const { speechSpanMs } = load("src/voice/vad.ts");
const { spokenFor } = load("src/i18n.ts", {
  "react-native": { Platform: { OS: "web" } },
  "@react-native-async-storage/async-storage": { default: {} },
});

const RATE = 16000;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

/** A vowel with a little fricative on it: what classifyBlock calls speech. */
function speech(seconds) {
  const n = Math.round(RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] =
      0.25 * Math.sin(2 * Math.PI * 300 * t) +
      0.2 * Math.sin(2 * Math.PI * 900 * t) +
      0.05 * Math.sin(2 * Math.PI * 3200 * t);
  }
  return out;
}

const silence = (seconds) => new Float32Array(Math.round(RATE * seconds));

function join(...parts) {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

console.log("\nhow long somebody spoke");
const SPANS = [
  // (name, samples, expected seconds)
  ["the wait before and after does not count", join(silence(4), speech(2), silence(3)), 2],
  ["a turn that is all speech is all of it", speech(3), 3],
  ["a pause inside a sentence stays inside it", join(speech(1), silence(0.4), speech(1)), 2.4],
  ["half a second measures as half a second", join(silence(2), speech(0.5), silence(2)), 0.5],
  ["a quiet car is zero, not a guess", silence(5), 0],
];
for (const [name, samples, expected] of SPANS) {
  const got = speechSpanMs(samples, RATE) / 1000;
  check(name, Math.abs(got - expected) < 0.15, `measured ${got.toFixed(2)} s, expected ~${expected}`);
}

console.log("\nsaying it in Polish");
const POLISH = [
  // Under half a second has no number at all: "0 sekund" would be a lie about
  // a measurement, and the driver did speak.
  [0, "krócej"],
  [0.4, "krócej"],
  [0.6, "1 sekundę"],
  [1, "1 sekundę"],
  [1.4, "1 sekundę"],
  [2, "2 sekundy"],
  [4, "4 sekundy"],
  [5, "5 sekund"],
  [11, "11 sekund"],
  // The teens are the trap: 12–14 take the many-form even though 2–4 do not.
  [12, "12 sekund"],
  [14, "14 sekund"],
  [21, "21 sekund"],
  [22, "22 sekundy"],
  [25, "25 sekund"],
  [102, "102 sekundy"],
  [112, "112 sekund"],
];
for (const [seconds, expected] of POLISH) {
  const got = spokenFor("pl", seconds);
  check(`${seconds}s → ${expected}`, got.includes(expected), `said "${got}"`);
}

console.log("\nand in English");
for (const [seconds, expected] of [
  [0.4, "less than a second"],
  [1, "1 second"],
  [2, "2 seconds"],
  [21, "21 seconds"],
]) {
  const got = spokenFor("en", seconds);
  check(`${seconds}s → ${expected}`, got.includes(expected), `said "${got}"`);
}

console.log(failures ? `\n${failures} failing` : "\nall good");
process.exit(failures ? 1 : 0);
