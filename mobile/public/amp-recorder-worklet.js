/**
 * Pulls raw microphone frames off the audio thread.
 *
 * A worklet rather than the older ScriptProcessorNode because that one runs on
 * the main thread, where a re-render can make it drop samples mid-sentence.
 * src/voice/recorder.ts still falls back to it if loading this module fails,
 * which is the cheaper failure of the two.
 *
 * Lives in public/ because a worklet is loaded by URL at runtime — the bundler
 * never sees it, so it has to be a real file served at a stable path.
 */
class AmpRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // A copy, not a view: the runtime reuses the same backing buffer for the
    // next frame, so posting the view straight across delivers whatever
    // happens to be in it by the time the main thread reads it.
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}

registerProcessor("amp-recorder", AmpRecorderProcessor);
