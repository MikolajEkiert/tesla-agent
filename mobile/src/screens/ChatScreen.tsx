import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetchVehicleState, sendMessage } from "../api";
import { ChatInput } from "../components/ChatInput";
import { InstrumentStrip } from "../components/InstrumentStrip";
import { MessageRow } from "../components/MessageRow";
import { ToolLogLine } from "../components/ToolLogLine";
import { TypingDots } from "../components/TypingDots";
import { color, font, space } from "../theme";
import type { ChatItem, VehicleState } from "../types";

let nextId = 0;
const id = () => String(nextId++);

export function ChatScreen() {
  const [items, setItems] = useState<ChatItem[]>([
    {
      kind: "message",
      id: id(),
      role: "assistant",
      text: "Good evening. What do you need?",
    },
  ]);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [vehicle, setVehicle] = useState<VehicleState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);

  const refreshVehicle = useCallback(() => {
    fetchVehicleState()
      .then(setVehicle)
      .catch(() => {
        /* strip just shows nothing if the backend is unreachable */
      });
  }, []);

  useEffect(() => {
    refreshVehicle();
  }, [refreshVehicle]);

  const handleSend = useCallback(
    async (text: string) => {
      setError(null);
      setItems((prev) => [...prev, { kind: "message", id: id(), role: "user", text }]);
      setPending(true);
      try {
        const res = await sendMessage(text, history);
        setHistory(res.history);
        setItems((prev) => [
          ...prev,
          ...res.tool_trace.map(
            (call): ChatItem => ({ kind: "tool", id: id(), call })
          ),
          { kind: "message", id: id(), role: "assistant", text: res.reply },
        ]);
        refreshVehicle();
      } catch {
        setError("Couldn't reach Amp's backend. Is it running?");
      } finally {
        setPending(false);
      }
    },
    [history, refreshVehicle]
  );

  useEffect(() => {
    if (items.length) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [items, pending]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <InstrumentStrip state={vehicle} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
      >
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) =>
            item.kind === "message" ? (
              <MessageRow role={item.role} text={item.text} />
            ) : (
              <ToolLogLine call={item.call} />
            )
          }
          ListFooterComponent={pending ? <TypingDots /> : null}
        />
        {error && (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        <ChatInput onSend={handleSend} disabled={pending} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: color.bg,
  },
  flex: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  errorBar: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: 8,
    backgroundColor: "rgba(226,86,79,0.12)",
    borderWidth: 1,
    borderColor: color.alert,
  },
  errorText: {
    fontFamily: font.mono,
    fontSize: 12,
    color: color.alert,
  },
});
