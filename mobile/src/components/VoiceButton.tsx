import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from "react-native";
import { NotUnlockedError, transcribe } from "../api";
import { useLanguage } from "../LanguageContext";
import { color, radius } from "../theme";
import { primeSpeech } from "../voice/speak";
import {
  NothingRecordedError,
  VoiceRecorder,
  voiceInputSupported,
} from "../voice/recorder";

/** Frames arrive hundreds of times a second; the meter only needs to look
 *  alive. Without this the level drives a re-render per audio frame. */
const LEVEL_INTERVAL_MS = 100;

type Phase = "idle" | "recording" | "transcribing";

/**
 * Hold to speak, release to send.
 *
 * Hold-and-release rather than tap-to-start/tap-to-stop because it has no
 * ambiguous state: the microphone is live exactly while a finger is down, so
 * there is never a moment where the app is listening and you think it isn't.
 * It also makes cancelling obvious — keep holding and say nothing.
 *
 * The transcript is sent immediately rather than dropped into the text box for
 * approval. Confirming every sentence would defeat the point in a car, and the
 * transcript still lands in the chat as your own message, so a mishearing is
 * visible and correctable straight after.
 */
export function VoiceButton({
  onTranscript,
  onStatus,
  onLocked,
  disabled,
}: {
  onTranscript: (text: string) => void;
  /** Transient one-line feedback, or null to clear it. */
  onStatus: (message: string | null) => void;
  onLocked?: () => void;
  disabled?: boolean;
}) {
  const { language, t } = useLanguage();
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const releasedRef = useRef(false);
  const lastLevelAt = useRef(0);

  // A recorder still running when this unmounts would keep the microphone open
  // and leave iOS showing the recording indicator over an app that is gone.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setPhase("transcribing");
    setLevel(0);
    try {
      const text = (await transcribe(await recorder.stop(), language)).trim();
      if (text) {
        onStatus(null);
        onTranscript(text);
      } else {
        onStatus(t("voiceSilence"));
      }
    } catch (e) {
      if (e instanceof NothingRecordedError) {
        onStatus(e.message === "silence" ? t("voiceSilence") : t("voiceTooShort"));
      } else if (e instanceof NotUnlockedError) {
        onLocked?.();
      } else {
        onStatus(t("voiceFailed"));
      }
    } finally {
      setPhase("idle");
    }
  }, [language, onLocked, onStatus, onTranscript, t]);

  const begin = useCallback(async () => {
    if (phase !== "idle" || disabled) return;
    releasedRef.current = false;
    onStatus(null);
    // The reply arrives seconds from now, long after iOS stops counting this
    // as a user gesture — so unlock speech while the finger is still down.
    primeSpeech();

    const recorder = new VoiceRecorder();
    recorder.onLevel = (value) => {
      const now = Date.now();
      if (now - lastLevelAt.current < LEVEL_INTERVAL_MS) return;
      lastLevelAt.current = now;
      setLevel(value);
    };
    recorder.onAutoStop = () => void finish();

    // Set before awaiting: getUserMedia can take a moment (and shows a
    // permission sheet the first time), and a button that looks dead until it
    // resolves invites a second press.
    setPhase("recording");
    try {
      await recorder.start();
      if (releasedRef.current) {
        // Released during startup — a tap rather than a hold. Nothing was
        // captured, so tear down instead of leaving the microphone live.
        recorder.cancel();
        setPhase("idle");
        onStatus(t("voiceTooShort"));
        return;
      }
      recorderRef.current = recorder;
    } catch (e) {
      recorder.cancel();
      setPhase("idle");
      const denied =
        e instanceof Error && (e.name === "NotAllowedError" || e.name === "SecurityError");
      onStatus(denied ? t("voiceDenied") : t("voiceFailed"));
    }
  }, [disabled, finish, onStatus, phase, t]);

  const release = useCallback(() => {
    releasedRef.current = true;
    if (recorderRef.current) void finish();
  }, [finish]);

  if (!voiceInputSupported()) return null;

  const recording = phase === "recording";
  const busy = phase === "transcribing";
  // Peaks rarely reach 1.0 in normal speech, so the ring is scaled to the part
  // of the range a voice actually occupies.
  const ring = recording ? 1 + Math.min(level * 2.5, 1) * 0.35 : 1;

  return (
    <View style={styles.wrap}>
      {recording && (
        <View style={[styles.ring, { transform: [{ scale: ring }] }]} pointerEvents="none" />
      )}
      <Pressable
        onPressIn={begin}
        onPressOut={release}
        disabled={disabled || busy}
        hitSlop={10}
        accessibilityLabel={t("voiceHold")}
        style={[
          styles.button,
          recording && styles.buttonRecording,
          (disabled || busy) && styles.buttonDisabled,
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={color.bg} />
        ) : (
          <View style={styles.mic}>
            <View style={[styles.capsule, recording && styles.glyphActive]} />
            <View style={[styles.arc, recording && styles.arcActive]} />
            <View style={[styles.stem, recording && styles.glyphActive]} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 44,
    height: 44,
    marginLeft: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.brand,
    opacity: 0.25,
  },
  button: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
    justifyContent: "center",
    // Without this a press-and-hold on iOS raises the text-selection callout
    // over the button, which cancels the gesture mid-sentence.
    ...(Platform.OS === "web"
      ? ({ userSelect: "none", WebkitTouchCallout: "none" } as object)
      : {}),
  },
  buttonRecording: {
    backgroundColor: color.brand,
    borderColor: color.brand,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  mic: {
    alignItems: "center",
    justifyContent: "center",
    height: 20,
  },
  capsule: {
    width: 7,
    height: 11,
    borderRadius: 3.5,
    backgroundColor: color.textSecondary,
  },
  arc: {
    width: 13,
    height: 6,
    marginTop: 1,
    borderBottomLeftRadius: 7,
    borderBottomRightRadius: 7,
    borderWidth: 1.5,
    borderTopWidth: 0,
    borderColor: color.textSecondary,
  },
  stem: {
    width: 1.5,
    height: 2,
    backgroundColor: color.textSecondary,
  },
  glyphActive: {
    backgroundColor: color.bg,
  },
  arcActive: {
    borderColor: color.bg,
  },
});
