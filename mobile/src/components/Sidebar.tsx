import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage } from "../LanguageContext";
import type { TranslationKey } from "../i18n";
import { color, font, motion, radius, space, type } from "../theme";
import type { ChatSummary } from "../chats";
import type { ScheduledAction } from "../types";
import { AmpMark } from "./AmpMark";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconPencil, IconPlus, IconPower, IconSliders, IconTrash } from "./icons";

const PANEL_WIDTH = 304;

/** Minutes from now until `unixSeconds`, floored at zero. */
function minutesUntil(unixSeconds: number | null): number | null {
  if (unixSeconds == null) return null;
  return Math.max(0, (unixSeconds * 1000 - Date.now()) / 60000);
}

/** Whole days between two moments, by calendar rather than by elapsed hours —
 *  something said at 23:50 was "yesterday" at 00:10, not "twenty minutes ago". */
function daysAgo(then: number, now: number): number {
  const start = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((start(now) - start(then)) / 86_400_000);
}

/** Pointer-over, for the desktop where the drawer is a permanent column and a
 *  row with no reaction reads as static text rather than something to open.
 *  Both handlers simply never fire on a touch screen. */
function useHover() {
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    handlers: {
      onHoverIn: () => setHovered(true),
      onHoverOut: () => setHovered(false),
    },
  };
}

function ChatRow({
  chat,
  active,
  onOpen,
  onDelete,
  onRename,
}: {
  chat: ChatSummary;
  active: boolean;
  onOpen: (id: string) => void;
  onDelete: (chat: ChatSummary) => void;
  onRename: (id: string, title: string) => void;
}) {
  const { t, language } = useLanguage();
  const { hovered, handlers } = useHover();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);

  const days = daysAgo(chat.updatedAt, Date.now());
  const when =
    days <= 0
      ? new Date(chat.updatedAt).toLocaleTimeString(language === "pl" ? "pl-PL" : "en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : days === 1
      ? t("chatYesterday")
      : new Date(chat.updatedAt).toLocaleDateString(language === "pl" ? "pl-PL" : "en-GB", {
          day: "numeric",
          month: "short",
        });

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== chat.title) onRename(chat.id, draft);
  };

  if (editing) {
    return (
      <View style={[styles.row, styles.rowEditing]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          autoFocus
          selectTextOnFocus
          returnKeyType="done"
          placeholder={t("chatUntitled")}
          placeholderTextColor={color.textTertiary}
          style={styles.renameInput}
        />
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => onOpen(chat.id)}
      onLongPress={() => {
        setDraft(chat.title);
        setEditing(true);
      }}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        (hovered || pressed) && styles.rowHovered,
        active && styles.rowActive,
      ]}
      {...handlers}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, active && styles.rowTitleActive]} numberOfLines={1}>
          {chat.title || t("chatUntitled")}
        </Text>
        <Text style={styles.rowMeta}>{when}</Text>
      </View>
      {/* Revealed by pointing at the row on a desktop, and always there on a
          touch screen, where there is nothing to point with. Long-pressing the
          row renames it too, which is the gesture a phone already teaches. */}
      {(hovered || active || Platform.OS !== "web") && (
        <View style={styles.rowTools}>
          <Pressable
            onPress={() => {
              setDraft(chat.title);
              setEditing(true);
            }}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t("chatRename")}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          >
            <IconPencil size={14} color={color.textTertiary} />
          </Pressable>
          <Pressable
            onPress={() => onDelete(chat)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t("chatDeleteConfirm")}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
          >
            <IconTrash size={14} color={color.textTertiary} />
          </Pressable>
        </View>
      )}
    </Pressable>
  );
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
    <View style={styles.queueRow}>
      <View style={[styles.queueDot, { backgroundColor: dot }]} />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, !active && styles.rowTitleMuted]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={2}>
          {action.error ?? status}
        </Text>
      </View>
      {action.cancellable && (
        <Pressable
          onPress={() => onCancel(action.id)}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => [styles.cancelButton, pressed && styles.iconButtonPressed]}
        >
          <Text style={styles.cancelText}>{t("queueCancel")}</Text>
        </Pressable>
      )}
    </View>
  );
}

function FooterRow({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const { hovered, handlers } = useHover();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.footerRow, (hovered || pressed) && styles.rowHovered]}
      {...handlers}
    >
      {children}
      <Text style={styles.footerLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * Conversation history, the scheduled-action queue, and the way into settings.
 *
 * Two shapes, one component. On a phone it is an overlay that slides in over
 * the chat and is dismissed by tapping away. On a wide screen it is `docked`: a
 * permanent left column with no backdrop and nothing to dismiss, because there
 * is room for both and hiding the history behind a button is a phone
 * compromise, not a design.
 */
export function Sidebar({
  open,
  docked = false,
  onClose,
  actions,
  onCancelAction,
  chats,
  activeChatId,
  onOpenChat,
  onDeleteChat,
  onRenameChat,
  onNewChat,
  onOpenSettings,
  onLock,
}: {
  open: boolean;
  /** Render as a permanent column rather than a dismissible overlay. */
  docked?: boolean;
  onClose: () => void;
  actions: ScheduledAction[];
  onCancelAction: (id: string) => void;
  /** Stored conversations, newest first. */
  chats: ChatSummary[];
  /** The one on screen right now, so the list can say which. */
  activeChatId: string | null;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  /** Ends the session on this device — the lever for a lost or lent phone. */
  onLock?: () => void;
}) {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(open ? 0 : -PANEL_WIDTH)).current;
  const fade = useRef(new Animated.Value(open ? 1 : 0)).current;
  // Deleting used to happen on the first tap, with no way back — while
  // disconnecting the car, which can be undone by logging in again, asked
  // first. The hierarchy was upside down.
  const [pendingDelete, setPendingDelete] = useState<ChatSummary | null>(null);

  useEffect(() => {
    if (docked) return;
    Animated.parallel([
      Animated.timing(slide, {
        toValue: open ? 0 : -PANEL_WIDTH,
        duration: motion.base,
        easing: Easing.out(Easing.cubic),
        // Layout-only animations can't use the native driver on web, and this
        // component's whole job is to render identically in the PWA.
        useNativeDriver: Platform.OS !== "web",
      }),
      Animated.timing(fade, {
        toValue: open ? 1 : 0,
        duration: motion.base,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== "web",
      }),
    ]).start();
  }, [open, docked, slide, fade]);

  /**
   * Push the panel back off the edge with a finger.
   *
   * Follows the drag rather than waiting for release, because a drawer that
   * only reacts once you let go does not feel attached to the hand. Claims the
   * gesture only when it is clearly sideways — the list below scrolls
   * vertically, and stealing that would trade one gesture for another.
   */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_, g) => {
          if (g.dx < 0) slide.setValue(Math.max(-PANEL_WIDTH, g.dx));
        },
        onPanResponderRelease: (_, g) => {
          if (g.dx < -PANEL_WIDTH / 3 || g.vx < -0.5) {
            onClose();
            return;
          }
          Animated.timing(slide, {
            toValue: 0,
            duration: motion.fast,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== "web",
          }).start();
        },
      }),
    [onClose, slide]
  );

  const deleteDialog = (
    <ConfirmDialog
      visible={pendingDelete !== null}
      title={t("chatDeleteTitle")}
      body={pendingDelete?.title || t("chatDeleteBody")}
      confirmLabel={t("chatDeleteConfirm")}
      onConfirm={() => {
        const victim = pendingDelete;
        setPendingDelete(null);
        if (victim) onDeleteChat(victim.id);
      }}
      onCancel={() => setPendingDelete(null)}
    />
  );

  const content = (
    <>
      <View style={styles.head}>
        <AmpMark size={15} />
        <Text style={styles.brand}>AMP</Text>
      </View>

      <Pressable
        onPress={onNewChat}
        accessibilityRole="button"
        style={({ pressed }) => [styles.newChat, pressed && styles.newChatPressed]}
      >
        <IconPlus size={14} color={color.textPrimary} />
        <Text style={styles.newChatLabel}>{t("chatNew")}</Text>
      </Pressable>

      {/* One scroller for both lists rather than two side by side: on a
          phone-height panel two independently scrolling boxes each get half the
          room and neither can show much. */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.sectionTitle}>{t("chatsTitle")}</Text>
        {chats.length === 0 ? (
          <Text style={styles.empty}>{t("chatsEmpty")}</Text>
        ) : (
          chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              active={chat.id === activeChatId}
              onOpen={onOpenChat}
              onDelete={setPendingDelete}
              onRename={onRenameChat}
            />
          ))
        )}

        <Text style={[styles.sectionTitle, styles.sectionGap]}>{t("queueTitle")}</Text>
        {actions.length === 0 ? (
          <Text style={styles.empty}>{t("queueEmpty")}</Text>
        ) : (
          actions.map((action) => (
            <ActionRow key={action.id} action={action} onCancel={onCancelAction} />
          ))
        )}
      </ScrollView>

      <View style={styles.footer}>
        <FooterRow label={t("settingsTitle")} onPress={onOpenSettings}>
          <IconSliders size={15} color={color.textSecondary} background={color.surface} />
        </FooterRow>
        {onLock && (
          <FooterRow label={t("lockApp")} onPress={onLock}>
            <IconPower size={15} color={color.textSecondary} background={color.surface} />
          </FooterRow>
        )}
      </View>
    </>
  );

  if (docked) {
    return (
      // No safe-area padding of its own: docked, it lives inside the screen's
      // SafeAreaView, which has already stepped around the notch.
      <View
        style={[
          styles.panel,
          styles.panelDocked,
          { paddingTop: space.lg, paddingBottom: insets.bottom + space.md },
        ]}
      >
        {content}
        {deleteDialog}
      </View>
    );
  }

  // Unmounted while closed so it never swallows taps meant for the chat.
  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: fade }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>

      <Animated.View
        {...pan.panHandlers}
        style={[
          styles.panel,
          {
            paddingTop: insets.top + space.lg,
            paddingBottom: insets.bottom + space.md,
            transform: [{ translateX: slide }],
          },
        ]}
      >
        {content}
      </Animated.View>

      {deleteDialog}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PANEL_WIDTH,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
  },
  panelDocked: {
    position: "relative",
    top: undefined,
    bottom: undefined,
    height: "100%",
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingBottom: space.lg,
  },
  brand: {
    fontFamily: font.displayBold,
    fontSize: 13,
    letterSpacing: 2.5,
    color: color.textPrimary,
  },
  newChat: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    marginBottom: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  newChatPressed: {
    backgroundColor: color.surfacePressed,
  },
  newChatLabel: {
    ...type.label,
    fontSize: 14,
    fontFamily: font.bodySemiBold,
    color: color.textPrimary,
  },
  sectionTitle: {
    ...type.eyebrow,
    color: color.textTertiary,
    paddingHorizontal: space.sm,
    marginBottom: space.sm,
  },
  sectionGap: {
    marginTop: space.xl,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: space.lg,
  },
  empty: {
    ...type.label,
    color: color.textTertiary,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
  },
  // No rules between rows. Separation is a hover state and a radius, which is
  // what a modern list uses, and it stops the panel reading as a table.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  rowHovered: {
    backgroundColor: color.surfaceRaised,
  },
  rowActive: {
    backgroundColor: color.surfaceRaised,
  },
  rowEditing: {
    backgroundColor: color.surfaceRaised,
    paddingVertical: space.xs,
  },
  rowBody: {
    flex: 1,
  },
  rowTitle: {
    ...type.label,
    fontSize: 14,
    color: color.textSecondary,
  },
  rowTitleActive: {
    color: color.textPrimary,
    fontFamily: font.bodySemiBold,
  },
  rowTitleMuted: {
    color: color.textTertiary,
  },
  rowMeta: {
    ...type.caption,
    fontSize: 10,
    color: color.textTertiary,
    marginTop: 1,
  },
  rowTools: {
    flexDirection: "row",
    gap: 2,
  },
  renameInput: {
    flex: 1,
    ...type.label,
    fontSize: 14,
    color: color.textPrimary,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : {}),
  },
  queueRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
  queueDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 6,
  },
  iconButton: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  iconButtonPressed: {
    backgroundColor: color.surfacePressed,
  },
  cancelButton: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  cancelText: {
    ...type.label,
    fontSize: 12,
    color: color.brand,
  },
  footer: {
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  footerLabel: {
    ...type.label,
    fontSize: 14,
    color: color.textSecondary,
  },
});
