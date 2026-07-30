import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { BackendError, confirmAction } from "../api";
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
};

export function ConfirmCard({
  token,
  tool,
  onDone,
  onDismiss,
}: {
  token: string;
  tool: string;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<"done" | "dismissed" | null>(null);

  const labelKey = LABEL_FOR_TOOL[tool];
  const what = labelKey ? t(labelKey) : tool;

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
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Pressable
          onPress={() => {
            setSettled("dismissed");
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
});
