import React, { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../LanguageContext";
import type { TranslationKey } from "../i18n";
import { color, font, radius, space } from "../theme";
import type { ScheduledAction } from "../types";

const PANEL_WIDTH = 300;

/** Minutes from now until `unixSeconds`, floored at zero. */
function minutesUntil(unixSeconds: number | null): number | null {
  if (unixSeconds == null) return null;
  return Math.max(0, (unixSeconds * 1000 - Date.now()) / 60000);
}

function ActionRow({
  action,
  onCancel,
}: {
  action: ScheduledAction;
  onCancel: (id: string) => void;
}) {
  const { t } = useLanguage();

  const temp = action.meta?.temp_c;
  const title =
    action.kind === "climate"
      ? temp != null
        ? `${t("queueClimate")} ${temp}°C`
        : t("queueClimate")
      : action.kind;

  const mins = minutesUntil(action.next_run_at);
  const relative =
    mins == null
      ? null
      : mins < 1
      ? t("lessThanAMinute")
      : t("minutesShort", { n: Math.round(mins) });

  let status: string;
  if (action.state === "running") {
    status = relative ? t("queueStopsIn", { n: relative }) : t("queueRunning");
  } else if (action.state === "scheduled") {
    status = relative ? t("queueStartsIn", { n: relative }) : t("queueRunning");
  } else {
    const key: TranslationKey =
      action.state === "done"
        ? "queueDone"
        : action.state === "cancelled"
        ? "queueCancelled"
        : "queueFailed";
    status = t(key);
  }

  const active = action.state === "running" || action.state === "scheduled";
  const dot =
    action.state === "failed"
      ? color.alert
      : action.state === "running"
      ? color.climate
      : active
      ? color.security
      : color.textTertiary;

  return (
    <View style={styles.row}>
      <View style={[styles.rowDot, { backgroundColor: dot }]} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, !active && styles.rowTitleMuted]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowStatus} numberOfLines={2}>
          {action.error ?? status}
        </Text>
      </View>
      {action.cancellable && (
        <Pressable onPress={() => onCancel(action.id)} hitSlop={8} style={styles.cancelButton}>
          <Text style={styles.cancelText}>{t("queueCancel")}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Left drawer: the scheduled-action queue plus a way into settings. Built as
 * sections from the start because conversation history lands here next — it
 * should be an insertion, not a rewrite.
 */
export function Sidebar({
  open,
  onClose,
  actions,
  onCancelAction,
  onOpenSettings,
  onLock,
}: {
  open: boolean;
  onClose: () => void;
  actions: ScheduledAction[];
  onCancelAction: (id: string) => void;
  onOpenSettings: () => void;
  /** Ends the session on this device — the lever for a lost or lent phone. */
  onLock?: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(open ? 0 : -PANEL_WIDTH)).current;
  const fade = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: open ? 0 : -PANEL_WIDTH,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        // Layout-only animations can't use the native driver on web, and
        // this component's whole job is to render identically in the PWA.
        useNativeDriver: Platform.OS !== "web",
      }),
      Animated.timing(fade, {
        toValue: open ? 1 : 0,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== "web",
      }),
    ]).start();
  }, [open, slide, fade]);

  // Unmounted while closed so it never swallows taps meant for the chat.
  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          {
            paddingTop: insets.top + space.lg,
            paddingBottom: insets.bottom + space.md,
            transform: [{ translateX: slide }],
          },
        ]}
      >
        <Text style={styles.brand}>AMP</Text>

        <Text style={styles.sectionTitle}>{t("queueTitle")}</Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {actions.length === 0 ? (
            <Text style={styles.empty}>{t("queueEmpty")}</Text>
          ) : (
            actions.map((action) => (
              <ActionRow key={action.id} action={action} onCancel={onCancelAction} />
            ))
          )}
        </ScrollView>

        <Pressable onPress={onOpenSettings} style={styles.settingsRow}>
          <Text style={styles.settingsGlyph}>⚙</Text>
          <Text style={styles.settingsLabel}>{t("settingsTitle")}</Text>
        </Pressable>

        {onLock && (
          <Pressable onPress={onLock} style={styles.lockRow}>
            <Text style={styles.settingsGlyph}>⏻</Text>
            <Text style={styles.settingsLabel}>{t("lockApp")}</Text>
          </Pressable>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PANEL_WIDTH,
    backgroundColor: color.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: color.hairline,
    paddingHorizontal: space.lg,
  },
  brand: {
    fontFamily: font.displayBold,
    fontSize: 13,
    letterSpacing: 3,
    color: color.textPrimary,
    marginBottom: space.xl,
  },
  sectionTitle: {
    fontFamily: font.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: color.textTertiary,
    marginBottom: space.sm,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: space.lg,
  },
  empty: {
    fontFamily: font.body,
    fontSize: 13,
    color: color.textTertiary,
    paddingVertical: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  rowDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 6,
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    fontFamily: font.bodyMedium,
    fontSize: 14,
    color: color.textPrimary,
  },
  rowTitleMuted: {
    color: color.textSecondary,
  },
  rowStatus: {
    fontFamily: font.mono,
    fontSize: 11,
    color: color.textTertiary,
    marginTop: 2,
  },
  cancelButton: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  cancelText: {
    fontFamily: font.bodyMedium,
    fontSize: 12,
    color: color.brand,
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  lockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
  },
  settingsGlyph: {
    fontSize: 15,
    color: color.textSecondary,
  },
  settingsLabel: {
    fontFamily: font.bodyMedium,
    fontSize: 14,
    color: color.textSecondary,
  },
});
