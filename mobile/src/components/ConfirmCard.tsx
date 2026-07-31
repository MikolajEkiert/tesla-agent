import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { BackendError, confirmAction, discardAction } from "../api";
import { useLanguage } from "../LanguageContext";
import type { TranslationKey } from "../i18n";
import { color, font, radius, space, type } from "../theme";
import { railStyles } from "./rail";

/**
 * The tap that actually runs a physically consequential command.
 *
 * The assistant can only *propose* unlocking the car, opening the trunk or
 * triggering HomeLink — the backend parks those and hands back a token (see
 * backend/app/actions.py). This card is the only path from proposal to
 * execution, and it needs a human finger. That matters because the model's
 * context includes free text from anonymously-editable map databases: an
 * injected instruction can, at worst, make this card appear, which is visible
 * and refusable rather than a silently opened car.
 */
const LABEL_FOR_TOOL: Record<string, TranslationKey> = {
  unlock: "confirmUnlock",
  actuate_trunk: "confirmTrunk",
  trigger_homelink: "confirmHomelink",
  control_windows: "confirmWindows",
  set_sentry_mode: "confirmSentry",
  // Was missing, so the card for a software update showed the raw tool name.
  software_update: "confirmUpdate",
};

/**
 * Which argument decides what actually happens, per tool.
 *
 * "Open the trunk" is two different commands depending on one word, and the
 * card used to show neither — you were asked to approve "open the trunk" with
 * no way to tell front from rear. Naming the detail is the difference between
 * confirming and guessing.
 */
const DETAIL_ARG: Record<string, string> = {
  actuate_trunk: "which",
  control_windows: "command",
  set_sentry_mode: "on",
  software_update: "action",
};

/** Mirrors PENDING_TTL_S in backend/app/actions.py. The server forgets the
 *  token after this, so a card older than this is a button that can only
 *  fail — and until now it went on looking live indefinitely. */
const TOKEN_TTL_S = 120;

/** When the countdown appears. Showing it from the start would put a ticking
 *  clock on a decision that usually takes three seconds. */
const COUNTDOWN_FROM_S = 45;

function detailOf(tool: string, args: Record<string, unknown> | undefined): string | null {
  const key = DETAIL_ARG[tool];
  if (!key || !args || !(key in args)) return null;
  const value = args[key];
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export function ConfirmCard({
  token,
  tool,
  args,
  voice,
  onDone,
  onDismiss,
}: {
  token: string;
  tool: string;
  /** Straight from tool_trace — the client already holds it, so the card can
   *  say what it is about without a second round trip to the server. */
  args?: Record<string, unknown>;
  /** Whether saying the word will settle this card right now. */
  voice?: boolean;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<"done" | "dismissed" | null>(null);

  // Counted from the moment the card appeared rather than from a server
  // timestamp: the card is built from the response that created the token, so
  // the two are a network round trip apart — well inside a display rounded to
  // whole seconds.
  const bornAt = useRef(Date.now());
  const [remaining, setRemaining] = useState(TOKEN_TTL_S);

  useEffect(() => {
    if (settled) return;
    const tick = () => {
      const left = TOKEN_TTL_S - Math.floor((Date.now() - bornAt.current) / 1000);
      setRemaining(left);
      // Nothing more to count once it is gone; the card says so from here on.
      if (left <= 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [settled]);

  const labelKey = LABEL_FOR_TOOL[tool];
  const detail = detailOf(tool, args);
  const what = (labelKey ? t(labelKey) : tool) + (detail ? ` (${detail})` : "");
  const expired = remaining <= 0;

  if (settled) {
    // Says what it settled, not just that something was. A transcript full of
    // "Sent to the car." lines with nothing to tell them apart is a log that
    // records that things happened and not which.
    return (
      <View style={styles.wrap}>
        <View style={railStyles.gutter} />
        <View style={[styles.card, styles.cardQuiet]}>
          <Text style={styles.settled}>
            {settled === "done"
              ? t("confirmSettledDone", { what })
              : t("confirmSettledDismissed", { what })}
          </Text>
        </View>
      </View>
    );
  }

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmAction(token);
      setSettled("done");
      onDone();
    } catch (e) {
      setError(e instanceof BackendError ? e.message : t("errorUnreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
    {/* The rail runs on into the card: the system that raised this question is
        the one the dots above it named. */}
    <View style={railStyles.gutter}>
      <View style={railStyles.lineStub} />
    </View>
    <View style={[styles.card, expired && styles.cardQuiet]}>
      {/* Amber is the security system's colour everywhere else in the app, so
          the card announces which part of the car is waiting rather than just
          shouting. */}
      <View style={styles.eyebrowRow}>
        <View style={[styles.eyebrowDot, expired && styles.eyebrowDotQuiet]} />
        <Text style={[styles.eyebrow, expired && styles.eyebrowQuiet]}>
          {t("confirmEyebrow")}
        </Text>
      </View>
      <Text style={[styles.question, expired && styles.questionExpired]}>
        {t("confirmQuestion", { what })}
      </Text>
      {expired ? (
        <Text style={styles.expired}>{t("confirmExpired")}</Text>
      ) : (
        <>
          {voice && <Text style={styles.voiceHint}>{t("voiceConfirmSpoken")}</Text>}
          {remaining <= COUNTDOWN_FROM_S && (
            <Text style={styles.countdown}>{t("confirmExpiresIn", { n: remaining })}</Text>
          )}
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.row}>
            <Pressable
              onPress={() => {
                setSettled("dismissed");
                // Tell the server too, so declining actually removes the parked
                // command rather than only hiding the card that offers it.
                void discardAction(token);
                onDismiss();
              }}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [styles.dismiss, pressed && styles.dismissPressed]}
            >
              <Text style={styles.dismissText}>{t("confirmNo")}</Text>
            </Pressable>
            <Pressable
              onPress={run}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => [styles.approve, pressed && styles.approvePressed]}
            >
              {busy ? (
                <ActivityIndicator color={color.bg} />
              ) : (
                <Text style={styles.approveText}>{t("confirmYes")}</Text>
              )}
            </Pressable>
          </View>
        </>
      )}
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /** Indented to the same left edge as the reply above it, so a turn stays one
   *  column of content rather than a stack of differently-inset boxes. */
  wrap: {
    flexDirection: "row",
    marginVertical: space.sm,
  },
  card: {
    flex: 1,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  // Settled or expired: it is a record now, not a question.
  cardQuiet: {
    backgroundColor: color.surface,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginBottom: space.sm,
  },
  eyebrowDot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: color.security,
  },
  eyebrowDotQuiet: {
    backgroundColor: color.textTertiary,
  },
  eyebrow: {
    ...type.eyebrow,
    color: color.security,
  },
  eyebrowQuiet: {
    color: color.textTertiary,
  },
  question: {
    ...type.bodyStrong,
    color: color.textPrimary,
    marginBottom: space.md,
  },
  questionExpired: {
    color: color.textSecondary,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: "row",
    gap: space.sm,
    marginTop: space.xs,
  },
  dismiss: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
  },
  dismissPressed: {
    backgroundColor: color.surfaceHover,
  },
  dismissText: {
    ...type.label,
    fontSize: 14,
    color: color.textSecondary,
  },
  approve: {
    flex: 1.4,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.security,
    alignItems: "center",
  },
  approvePressed: {
    opacity: 0.75,
  },
  approveText: {
    fontFamily: font.bodySemiBold,
    fontSize: 14,
    color: color.bg,
  },
  settled: {
    ...type.caption,
    color: color.textTertiary,
  },
  expired: {
    ...type.caption,
    color: color.textTertiary,
  },
  countdown: {
    ...type.caption,
    color: color.textTertiary,
    marginBottom: space.sm,
  },
  error: {
    ...type.caption,
    color: color.alert,
    marginBottom: space.sm,
  },
  // Quiet: it is an available shortcut, not an instruction. The buttons stay
  // the obvious way to answer.
  voiceHint: {
    ...type.label,
    color: color.textTertiary,
    marginBottom: space.sm,
  },
});
