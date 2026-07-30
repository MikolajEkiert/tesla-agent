import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { BackendError, confirmAction, discardAction } from "../api";
import { useLanguage } from "../LanguageContext";
import type { TranslationKey } from "../i18n";
import { color, font, radius, space } from "../theme";

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

  const labelKey = LABEL_FOR_TOOL[tool];
  const detail = detailOf(tool, args);
  const what = (labelKey ? t(labelKey) : tool) + (detail ? ` (${detail})` : "");

  if (settled) {
    return (
      <View style={styles.card}>
        <Text style={styles.settled}>
          {settled === "done" ? t("confirmExecuted") : t("confirmDismissed")}
        </Text>
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
    <View style={styles.card}>
      <Text style={styles.question}>{t("confirmQuestion", { what })}</Text>
      {voice && <Text style={styles.voiceHint}>{t("voiceConfirmSpoken")}</Text>}
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
          style={styles.dismiss}
        >
          <Text style={styles.dismissText}>{t("confirmNo")}</Text>
        </Pressable>
        <Pressable onPress={run} disabled={busy} style={styles.approve}>
          {busy ? (
            <ActivityIndicator color={color.bg} />
          ) : (
            <Text style={styles.approveText}>{t("confirmYes")}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginVertical: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.security,
  },
  question: {
    fontFamily: font.bodyMedium,
    fontSize: 15,
    color: color.textPrimary,
    marginBottom: space.md,
  },
  row: {
    flexDirection: "row",
    gap: space.sm,
  },
  dismiss: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.hairline,
    alignItems: "center",
  },
  dismissText: {
    fontFamily: font.bodyMedium,
    fontSize: 14,
    color: color.textSecondary,
  },
  approve: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.security,
    alignItems: "center",
  },
  approveText: {
    fontFamily: font.bodySemiBold,
    fontSize: 14,
    color: color.bg,
  },
  settled: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.textTertiary,
  },
  error: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.alert,
    marginBottom: space.sm,
  },
  // Quiet: it is an available shortcut, not an instruction. The buttons stay
  // the obvious way to answer.
  voiceHint: {
    fontFamily: font.body,
    fontSize: 12,
    color: color.textTertiary,
    marginBottom: space.sm,
  },
});
