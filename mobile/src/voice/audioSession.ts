/**
 * Telling iOS what this page is going to do with audio.
 *
 * Safari exposes the platform's audio session as `navigator.audioSession`, and
 * the type set there is page-wide and immediate. Two of them matter here:
 *
 *   playback         — plays with the ringer switch silent. Cannot capture.
 *   play-and-record  — plays with the ringer switch silent, and can capture.
 *
 * "Cannot capture" is not a soft preference. With the session on `playback`,
 * getUserMedia throws
 *
 *     InvalidStateError: AudioSession category is not compatible with audio capture
 *
 * which is the error that made every voice control on the phone fail the
 * instant it was pressed, while the same build worked in Chrome — Chrome has
 * no audio session to get wrong.
 *
 * It was self-inflicted and it was in the tap itself: primeSpeech() declares
 * `playback` so a spoken reply is audible with the phone on silent, and it runs
 * from the same press that then opens the microphone. Play first, listen
 * second, a few milliseconds apart, every single time.
 *
 * So the two intentions are named separately, and whichever runs last in a
 * given gesture wins — which is the right order by construction, because the
 * capture paths ask for the microphone after priming speech.
 */

function session(): { type: string } | null {
  try {
    return (navigator as any).audioSession ?? null;
  } catch {
    return null;
  }
}

/**
 * About to open the microphone.
 *
 * `play-and-record` rather than `record`: a conversation plays a reply while
 * the microphone stays open for barge-in, so the session has to permit both at
 * once. Absent on every browser but Safari, hence the guard rather than a
 * feature test at the call site.
 */
export function prepareForCapture(): void {
  const s = session();
  if (!s) return;
  try {
    s.type = "play-and-record";
  } catch {
    // Read-only on this OS version. The capture attempt that follows will
    // report what actually happened, which is more use than a guess here.
  }
}

/**
 * Only going to play something.
 *
 * Left as `playback` because it is the type that earns the ringer switch, and
 * nothing is listening on this path. Any capture that starts afterwards raises
 * it again through prepareForCapture().
 */
export function prepareForPlayback(): void {
  const s = session();
  if (!s) return;
  try {
    s.type = "playback";
  } catch {
    // Not writable here; iOS keeps whatever it had decided.
  }
}
