/**
 * Telling speech apart from the other loud things that happen in a car.
 *
 * This exists because loudness alone does not do it, which cost a real
 * incident: hitting the seat produced a recording that passed an
 * amplitude-only check, went to the transcriber, and came back as a
 * confidently-worded command nobody had spoken. A thump is loud. Loudness was
 * never the signal.
 *
 * What separates them is *where* the energy sits. Rather than run an FFT on
 * the audio thread, both measures here are a single pass over the block:
 *
 *   rms  — loudness, still needed as a floor. Quiet is quiet.
 *   tilt — energy of the sample-to-sample difference over the energy of the
 *          block itself. The ratio rises with frequency, which makes it a
 *          cheap stand-in for spectral centroid: for a pure tone it works out
 *          to 4·sin²(πf/fs), so at 16 kHz an 80 Hz thump lands near 0.001, a
 *          1 kHz tone near 0.15, and uncorrelated hiss approaches 2.0.
 *
 * The measured numbers, over 128-sample blocks (see the table in
 * VOICE_PROFILE for where the thresholds came from):
 *
 *   clip                    in-band ms   consonant-band ms
 *   seat thumps                      0                   0
 *   broadband hiss                   0                   0
 *   engine/road rumble            3476                   0
 *   "nie"                          152                   0
 *   "tak"                          156                   8
 *   "otwórz bagażnik"              376                  60
 *   full sentence                 1252                 108
 *   same sentence over rumble     2428                 324
 *
 * The rumble row is the whole point. It sails through a loudness test and
 * through the in-band test — it is loud, and low-frequency energy is exactly
 * what a vowel looks like on a coarse measure. What it never produces is a
 * fricative. So the gate is two kinds of evidence, and noise supplies at most
 * one of them.
 *
 * The "nie" row is the honest cost. That word is voiced end to end — a nasal
 * and two vowels — and produces no fricative either, so this gate drops it.
 * Measured against rumble it is not merely close but *less* speech-like on
 * every feature tried: spectral variability 0.273 against rumble's 0.257,
 * peak tilt lower. Separating the two was attempted and abandoned rather than
 * fudged. The trade is deliberate — a dropped word costs a repeat, an
 * accepted noise burst cost a command nobody spoke — and the clip was
 * synthesised speech, which lacks the breath a person puts on a short word,
 * so a real "nie" may well carry enough.
 *
 * Deliberately free of imports and of React, so it can be compiled on its own
 * and run over recorded WAV files — which is how the table above was made,
 * and how it should be re-checked if these numbers are ever changed.
 */

/** Analysis block size. Fixed rather than following the caller's frame size,
 *  because the two capture paths disagree: the AudioWorklet delivers 128
 *  samples, the ScriptProcessor fallback 4096. Averaging a fricative across a
 *  256 ms block would erase exactly the evidence this is looking for. */
export const BLOCK_SIZE = 128;

/**
 * Blocks overlap by half.
 *
 * Found by testing rather than theory: the word "nie" has exactly one
 * fricative block in it, and reading the same recording from a different
 * byte offset split that one block in two and lost it — the same clip
 * measured 8 ms of consonant in one implementation and 0 ms in another, which
 * is the difference between a one-word answer working and being silently
 * discarded. A short event that straddles a boundary is whole in some window
 * when the windows overlap. Counters advance by the hop, not the block, so
 * totals still read as milliseconds of audio rather than double-counting.
 */
export const HOP_SIZE = BLOCK_SIZE / 2;

export interface BlockStats {
  /** 0..1, loudness of this block. */
  rms: number;
  /** Ratio described above: low for rumble, high for hiss, mid for speech. */
  tilt: number;
}

export function blockStats(block: Float32Array): BlockStats {
  if (block.length < 2) return { rms: 0, tilt: 0 };

  let energy = 0;
  let diffEnergy = 0;
  for (let i = 0; i < block.length; i++) {
    energy += block[i] * block[i];
    if (i > 0) {
      const d = block[i] - block[i - 1];
      diffEnergy += d * d;
    }
  }

  const rms = Math.sqrt(energy / block.length);
  // Guard the division here rather than in the caller: a digitally silent
  // block has no meaningful tilt, and 0 keeps it below every speech floor.
  const tilt = energy > 1e-12 ? diffEnergy / energy : 0;
  return { rms, tilt };
}

export interface VoiceProfile {
  /** Below this, too quiet to be someone talking to the phone. */
  minRms: number;
  /** Below this the energy is too low-frequency to be speech: a thump on a
   *  seat, a door, suspension over a pothole, engine rumble. */
  minTilt: number;
  /** Above this, too high-frequency to be speech: hiss, wind, fabric against
   *  the microphone, and the click of a transient. */
  maxTilt: number;
  /** Fricative territory. Nothing in the noise clips reached it; every spoken
   *  clip did. This is the measurement the gate leans on. */
  consonantTilt: number;
}

export const VOICE_PROFILE: VoiceProfile = {
  minRms: 0.015,
  minTilt: 0.02,
  maxTilt: 1.2,
  // 0.22 rather than 0.18: at 0.18 the rumble clip started leaking frames
  // (8 ms of them), and this threshold is the one keeping noise out.
  consonantTilt: 0.22,
};

export interface BlockClass {
  /** Loud, and in the frequency range speech occupies at all. */
  inBand: boolean;
  /** Loud, and specifically fricative-like. */
  consonant: boolean;
}

/** The rate every threshold in VOICE_PROFILE was measured at. */
export const PROFILE_RATE = 16000;

/**
 * Put a tilt measured at some other sample rate back on the profile's scale.
 *
 * Tilt is a ratio of differences to amplitudes, so it depends on how far apart
 * the samples are in time: for a pure tone it is 4·sin²(πf/fs), which means the
 * *same voice* reads nearly ten times lower at 48 kHz than at 16 kHz. Measured
 * on a 300+900 Hz vowel: 0.0329 at 16 kHz, 0.0038 at 48 kHz — one side of
 * minTilt (0.02) and then the other. Left uncorrected, a phone whose hardware
 * refuses 16 kHz would decide that nobody had spoken, every time.
 *
 * So the frequency implied by the measurement is recovered and re-measured at
 * the profile's rate. The obvious shortcut — scaling by (fs/16000)² — is right
 * for speech and badly wrong above it, because sin saturates: it turns white
 * noise from 2.26 into 16.7 and would drag hiss through the maxTilt gate that
 * exists to catch it. This inverts the relationship exactly instead, and lands
 * within a few percent from rumble to hiss.
 */
export function normaliseTilt(tilt: number, rate: number): number {
  if (rate === PROFILE_RATE || !rate) return tilt;
  const ratio = Math.min(1, Math.sqrt(Math.max(0, tilt)) / 2);
  return 4 * Math.sin((rate / PROFILE_RATE) * Math.asin(ratio)) ** 2;
}

export function classifyBlock(
  block: Float32Array,
  profile: VoiceProfile = VOICE_PROFILE,
  /** The rate this block was captured at. Defaults to the one the thresholds
   *  were measured at, so every existing caller is unaffected. */
  rate: number = PROFILE_RATE
): BlockClass {
  const { rms, tilt: raw } = blockStats(block);
  const tilt = normaliseTilt(raw, rate);
  if (rms < profile.minRms || tilt > profile.maxTilt) {
    return { inBand: false, consonant: false };
  }
  return {
    inBand: tilt >= profile.minTilt,
    consonant: tilt >= profile.consonantTilt,
  };
}

/**
 * How much of each kind of evidence a recording needs before it counts as
 * containing speech at all.
 *
 * The consonant figure is one block — the thinnest measurement in the table,
 * from the word "nie". It is deliberately not raised: rejecting a one-word
 * answer would break "tak"/"nie" in a conversation, and the noise clips did
 * not produce a *single* block in that band, so the separation is categorical
 * rather than a matter of margin. Both conditions must hold together, which
 * is what makes one stray transient insufficient on its own.
 */
export interface SpeechEvidence {
  minInBandMs: number;
  minConsonantMs: number;
}

export const SPEECH_EVIDENCE: SpeechEvidence = {
  // Under the 160 ms that the shortest real words measured.
  minInBandMs: 120,
  // One window. Thin, and deliberately so: "nie" is voiced end to end — a
  // nasal and two vowels, no fricative anywhere — and measures a single
  // window, while every noise clip measures exactly zero. The separation is
  // categorical rather than a comfortable margin, because to land in this
  // band at all a sound has to be neither low-frequency (thump, rumble) nor
  // broadband (hiss, click); it has to be shaped like speech.
  //
  // It holds only together with minInBandMs — one stray window is not enough
  // on its own. If invented commands ever come back, this is the first number
  // to raise, at the cost of one-word answers like "nie" being dropped.
  minConsonantMs: 4,
};

/**
 * How long somebody actually spoke, from the first sound shaped like speech to
 * the last.
 *
 * The buffer this reads is the whole listening window: the microphone is open
 * from the moment the assistant stops talking, so most of it is a car with
 * nobody saying anything. Reporting its length as "you spoke for N seconds"
 * would count the pause before the sentence and the one after it — a driver
 * who waits, says "tak", and waits again would be told they spoke for eight
 * seconds.
 *
 * So it is a span rather than a total, and the ends are found with the same
 * classifier the recorder gates on, at the thresholds measured for it. A span
 * keeps the pauses *inside* a sentence, which is what a person means by how
 * long they spoke; a total of in-band blocks would report the vowels alone and
 * come out absurdly short.
 *
 * Zero when nothing in the buffer was speech-shaped at all.
 */
export function speechSpanMs(samples: Float32Array, rate: number = PROFILE_RATE): number {
  let first = -1;
  let last = -1;
  for (let start = 0; start + BLOCK_SIZE <= samples.length; start += HOP_SIZE) {
    const block = samples.subarray(start, start + BLOCK_SIZE);
    if (!classifyBlock(block, VOICE_PROFILE, rate).inBand) continue;
    if (first < 0) first = start;
    last = start + BLOCK_SIZE;
  }
  if (first < 0) return 0;
  return ((last - first) / rate) * 1000;
}
