/**
 * Does a live conversation close when the goodbye stops, whatever order the
 * model does things in?
 *
 * Driving the real LiveSession, not a copy of its logic: the file is
 * transpiled and loaded with its four imports stubbed, so what is under test
 * is the state machine that actually ships. The three orderings below are the
 * three this has been wrong about, one at a time.
 *
 * Network-free and model-free: no socket is opened and no audio is decoded.
 * What is being proved is the ordering, not the talking.
 *
 * Run from mobile/:  node dev/check_live_end.js
 */
const fs = require("fs");
const path = require("path");
const ts = require(path.join(process.cwd(), "node_modules/typescript"));

const SRC = path.join(process.cwd(), "src/voice/live.ts");

// --- load live.ts with its world stubbed ---------------------------------

const stubs = {
  "react-native": { Platform: { OS: "web" } },
  "../api": { fetchLiveToken: async () => ({}), runLiveTool: async () => ({ ok: true }) },
  "./audioSession": { prepareForCapture() {} },
  "./recorder": { encodeWav: () => null, openMicrophone: async () => null },
  // Measuring the turn is somebody else's tested job (src/voice/vad.ts); here
  // it only has to answer, so a flushed turn does not throw.
  "./vad": { speechSpanMs: () => 2000 },
};

const js = ts.transpileModule(fs.readFileSync(SRC, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const mod = { exports: {} };
new Function("require", "module", "exports", js)(
  (name) => stubs[name] ?? {},
  mod,
  mod.exports
);
const { LiveSession } = mod.exports;

// --- a world for it to run in --------------------------------------------

global.WebSocket = { OPEN: 1 };

/** Every buffer source handed out, so a test can end playback deliberately. */
let sources = [];
function fakeAudioContext() {
  return {
    currentTime: 0,
    destination: {},
    createBuffer: (_c, len) => ({ duration: len / 24000, getChannelData: () => new Float32Array(len) }),
    createBufferSource: () => {
      const s = { buffer: null, connect() {}, start() {}, onended: null };
      sources.push(s);
      return s;
    },
    close() {},
  };
}
global.window = { AudioContext: fakeAudioContext };

/** Fire onended on everything queued — the car has finished saying it. */
function finishPlayback() {
  const queued = sources;
  sources = [];
  for (const s of queued) s.onended && s.onended();
}

function newSession() {
  const events = { concluded: 0, idle: 0, phases: [], spoke: [], said: [] };
  const session = new LiveSession({
    onUserSpoke: (seconds) => events.spoke.push(seconds),
    onAssistantTranscript: (text) => events.said.push(text),
    onTool: () => {},
    onConcluded: () => events.concluded++,
    onPhase: (p) => events.phases.push(p),
    onIdle: () => events.idle++,
    onClosed: () => {},
  });
  // Enough of a socket to satisfy send(); nothing reads what it is given.
  session.socket = { readyState: 1, send() {} };
  sources = [];
  return { session, events };
}

const said = (text) => ({
  serverContent: {
    outputTranscription: { text },
    modelTurn: { parts: [{ inlineData: { data: btoa("\0\0\0\0") } }] },
  },
});
const heard = (text) => ({ serverContent: { inputTranscription: { text } } });
const turnComplete = () => ({ serverContent: { turnComplete: true } });
const endCall = () => ({ toolCall: { functionCalls: [{ id: "1", name: "end_conversation" }] } });

const feed = (session, payload) => session.onMessage({ data: JSON.stringify(payload) });

// --- the cases ------------------------------------------------------------

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

async function farewellFirst() {
  // What the screenshot showed: "Dobrze. Szerokiej drogi! Do usłyszenia.",
  // then end_conversation on the way out of the same turn.
  console.log("\nfarewell first, then the request to close");
  const { session, events } = newSession();
  await feed(session, heard("Nie."));
  await feed(session, said("Dobrze. Szerokiej drogi! Do usłyszenia."));
  await feed(session, turnComplete());
  finishPlayback();
  check("nothing has closed yet — the request has not arrived", events.concluded === 0);
  await feed(session, endCall());
  check("closes as soon as it is asked, with no wait", events.concluded === 1,
    `onConcluded fired ${events.concluded} times`);
  check("the 8s backstop is not what closed it", session.endTimer === null,
    "endTimer still armed");
}

async function farewellStillPlaying() {
  // Same ordering, but the request arrives while the goodbye is still audible.
  console.log("\nthe request arrives while the goodbye is still playing");
  const { session, events } = newSession();
  await feed(session, heard("Nie."));
  await feed(session, said("Do usłyszenia."));
  await feed(session, turnComplete());
  await feed(session, endCall());
  check("waits for the car to finish saying it", events.concluded === 0);
  finishPlayback();
  check("closes the moment it stops", events.concluded === 1,
    `onConcluded fired ${events.concluded} times`);
}

async function requestFirst() {
  // The ordering the code was originally written for: ask, then say goodbye in
  // the turn after. Must still work.
  console.log("\nthe request first, farewell in the turn after");
  const { session, events } = newSession();
  await feed(session, heard("Nie."));
  await feed(session, endCall());
  check("does not close on an empty turn", events.concluded === 0);
  await feed(session, said("Do usłyszenia."));
  await feed(session, turnComplete());
  check("still waiting — the goodbye is playing", events.concluded === 0);
  finishPlayback();
  check("closes when the goodbye ends", events.concluded === 1,
    `onConcluded fired ${events.concluded} times`);
}

async function driverChangesMind() {
  // Speaking into the gap between the request and the farewell must call the
  // whole thing off, timer included.
  console.log("\nthe driver speaks again before the farewell");
  const { session, events } = newSession();
  await feed(session, heard("Nie."));
  await feed(session, endCall());
  await feed(session, heard("Czekaj, jeszcze jedno."));
  check("the pending close is dropped", session.endAfterReply === false);
  check("and so is its timer", session.endTimer === null, "endTimer still armed");
  await feed(session, said("Jasne, słucham."));
  await feed(session, turnComplete());
  finishPlayback();
  check("answering does not hang up", events.concluded === 0,
    `onConcluded fired ${events.concluded} times`);
}

async function answerIsNotAFarewell() {
  // An ordinary answered question must not leave the session primed to close.
  console.log("\nan ordinary turn is not a goodbye");
  const { session, events } = newSession();
  await feed(session, heard("Jaki mam zasięg?"));
  await feed(session, said("Około 250 kilometrów."));
  await feed(session, turnComplete());
  finishPlayback();
  check("nothing closes", events.concluded === 0);
  check("and it goes back to listening", events.phases[events.phases.length - 1] === "listening",
    `last phase was ${events.phases[events.phases.length - 1]}`);
}

async function spokenInsteadOfCalled() {
  // Measured in the car, twice in one drive: the model read the tool's name
  // out loud at the end of its farewell and then carried on listening, because
  // a spoken name calls nothing. The prompt no longer prints that identifier;
  // this is the net underneath it.
  console.log("\nthe model says the tool's name instead of calling it");
  const { session, events } = newSession();
  await feed(session, heard("Nie."));
  await feed(session, said("No to cześć, szerokiej drogi! end_conversation"));
  await feed(session, turnComplete());
  finishPlayback();
  check("it closes anyway", events.concluded === 1,
    `onConcluded fired ${events.concluded} times`);
  check("and the identifier is not shown to the driver",
    events.said.length === 1 && !/end_conversation/.test(events.said[0]),
    `logged ${JSON.stringify(events.said)}`);
  check("the farewell itself survives",
    /szerokiej drogi/i.test(events.said[0] ?? ""), `logged ${JSON.stringify(events.said)}`);
}

async function spokenTurnIsADuration() {
  // The driver's turn is a length now, never a transcript.
  console.log("\na spoken turn reaches the app as a duration");
  const { session, events } = newSession();
  // A turn with audio in it: the length is measured from what was captured,
  // and a turn that captured nothing is reported as zero rather than guessed.
  session.keepTurnAudio(new Float32Array(16000));
  await feed(session, heard("Wybierz trasę do najbliższego Orlenu."));
  await feed(session, said("Jasne."));
  check("one spoken turn, reported in seconds", events.spoke.length === 1 && events.spoke[0] === 2,
    `got ${JSON.stringify(events.spoke)}`);
  check("and none of what it thought it heard travels with it",
    !JSON.stringify(events.spoke).includes("Orlen"));
  const quiet = newSession();
  await feed(quiet.session, heard("Tak."));
  // The turn is handed up when the assistant starts answering, so the answer
  // is what makes it flush — same as above, minus the captured audio.
  await feed(quiet.session, said("Jasne."));
  check("a turn with no audio is zero, not a guess", quiet.events.spoke[0] === 0,
    `got ${JSON.stringify(quiet.events.spoke)}`);
}

(async () => {
  await spokenInsteadOfCalled();
  await spokenTurnIsADuration();
  await farewellFirst();
  await farewellStillPlaying();
  await requestFirst();
  await driverChangesMind();
  await answerIsNotAFarewell();
  console.log(failures ? `\n${failures} failing` : "\nall good");
  process.exit(failures ? 1 : 0);
})();
