import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from "react-native";
import { copyText } from "../clipboard";
import { useLanguage } from "../LanguageContext";
import { RichText } from "./RichText";
import { color, font, radius, space, type } from "../theme";
import type { Role } from "../types";
import { IconCopy, IconRetry, IconSpeak } from "./icons";
import { RAIL_GUTTER, railStyles } from "./rail";

/** How long "copied" stays up. Long enough to be read at a glance, short
 *  enough that it is gone before the next reply lands on top of it. */
const COPIED_FOR_MS = 1500;

/** A reply arrives whole from the backend, so this is a reveal, not streaming.
 *  Fixed in duration rather than per character: a long answer should not take
 *  proportionally longer to appear, it should just appear faster. */
const REVEAL_MS = 650;
const REVEAL_FRAME_MS = 32;

/**
 * Show a reply as if it were being written.
 *
 * The backend answers in one piece, and dropping a finished paragraph on screen
 * makes the wait before it feel like a stall. Uncovering it takes the same time
 * either way and gives the eye somewhere to start reading.
 *
 * Trailing Markdown marks are trimmed off each slice: mid-reveal the text is
 * routinely cut inside `**bold**`, and an unclosed pair would flash its
 * asterisks on screen before the closing one arrived.
 */
function useRevealed(text: string, enabled?: boolean): string {
  const [shown, setShown] = useState(enabled ? "" : text);

  useEffect(() => {
    if (!enabled) {
      setShown(text);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) {
        setShown(text);
        return;
      }
      const step = Math.max(1, Math.ceil(text.length / (REVEAL_MS / REVEAL_FRAME_MS)));
      let at = 0;
      timer = setInterval(() => {
        at += step;
        setShown(at >= text.length ? text : text.slice(0, at).replace(/[*`_]+$/, ""));
        if (at >= text.length && timer) clearInterval(timer);
      }, REVEAL_FRAME_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [text, enabled]);

  return shown;
}

function ActionButton({
  onPress,
  label,
  children,
}: {
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
    >
      {children}
    </Pressable>
  );
}

/**
 * One turn.
 *
 * What you said is a bubble, because you composed it and it has edges. What the
 * assistant said is not: it is set as plain text on the canvas, the way every
 * assistant worth reading sets its answers, and it hangs off the system rail
 * when the turn touched the car.
 *
 * The actions underneath follow the convention people already have: they belong
 * to the latest turn, and appear on any older one you point at. Showing them
 * under every message forever turns a transcript into a control panel.
 */
export function MessageRow({
  role,
  text,
  attached,
  showActions,
  reveal,
  onSpeak,
  onResend,
}: {
  role: Role;
  text: string;
  /** The turn above this one touched the car, so the rail runs into it. */
  attached?: boolean;
  /** This is the newest turn — its actions stay visible without hovering. */
  showActions?: boolean;
  /** Uncover the text as it is read rather than dropping it in whole. Set only
   *  on a reply that has just arrived, never on restored history. */
  reveal?: boolean;
  /** Read this reply aloud. Omitted where speech is switched off. */
  onSpeak?: () => void;
  /** Ask this again, unchanged. User turns only. */
  onResend?: () => void;
}) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownText = useRevealed(text, reveal && role === "assistant");

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = () => {
    void copyText(text).then((ok) => {
      // Silence on failure is deliberate: an insecure origin with no clipboard
      // is not something the driver can act on, and a red error over a message
      // they only meant to copy is worse than nothing happening.
      if (!ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
    });
  };

  const actionsVisible = showActions || hovered;
  const hover = {
    onHoverIn: () => setHovered(true),
    onHoverOut: () => setHovered(false),
  };

  if (role === "user") {
    return (
      <View style={styles.userRow} {...hover}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{text}</Text>
        </View>
        <View style={styles.userFooter}>
          {copied && <Text style={styles.footnote}>{t("copied")}</Text>}
          {actionsVisible && (
            <>
              <ActionButton onPress={copy} label={t("copyMessage")}>
                <IconCopy size={14} color={color.textTertiary} />
              </ActionButton>
              {onResend && (
                <ActionButton onPress={onResend} label={t("resendMessage")}>
                  <IconRetry size={14} color={color.textTertiary} />
                </ActionButton>
              )}
            </>
          )}
        </View>
      </View>
    );
  }

  // Through the formatter, because the model writes Markdown whether or not
  // anything reads it — a list of restaurants came back as "**Pani Pasta**"
  // and that is what the screen showed.
  return (
    <View style={styles.assistantRow} {...hover}>
      <View style={styles.assistantLine}>
        <View style={railStyles.gutter}>
          {attached && <View style={railStyles.lineStub} />}
        </View>
        <View style={styles.assistantBody}>
          <RichText text={shownText} style={styles.assistantText} />
        </View>
      </View>
      {actionsVisible && (
        <View style={styles.assistantFooter}>
          {onSpeak && (
            <ActionButton onPress={onSpeak} label={t("speakMessage")}>
              <IconSpeak size={15} color={color.textTertiary} />
            </ActionButton>
          )}
          <ActionButton onPress={copy} label={t("copyMessage")}>
            <IconCopy size={14} color={color.textTertiary} />
          </ActionButton>
          {copied && <Text style={styles.footnote}>{t("copied")}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: {
    alignItems: "flex-end",
    marginTop: space.xl,
    marginBottom: space.sm,
  },
  userBubble: {
    maxWidth: "84%",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.xl,
    borderBottomRightRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  userText: {
    ...type.body,
    fontFamily: font.bodyMedium,
    color: color.textPrimary,
  },
  userFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    minHeight: 20,
    marginTop: 2,
    marginRight: space.xs,
  },
  footnote: {
    ...type.caption,
    fontSize: 10,
    letterSpacing: 0.8,
    color: color.textTertiary,
  },
  assistantRow: {
    marginBottom: space.sm,
  },
  assistantLine: {
    flexDirection: "row",
  },
  // Stretched, or the text inside wraps at whatever narrow width a shrunk
  // child View settles on and words break down the middle.
  assistantBody: {
    flex: 1,
    maxWidth: 620,
  },
  assistantText: {
    ...type.body,
    color: color.textPrimary,
  },
  assistantFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    marginTop: space.xs,
    marginLeft: RAIL_GUTTER - space.xs,
  },
  action: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  actionPressed: {
    backgroundColor: color.surfaceHover,
  },
});
