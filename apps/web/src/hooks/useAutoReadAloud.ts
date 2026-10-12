import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import type { ChatMessage } from "~/types";
import { useSpokenMessage } from "~/hooks/useSpokenMessage";

interface TimelineMessageRow {
  readonly kind: "message";
  readonly message: ChatMessage;
}

/**
 * Gemini-style read-aloud automation: while enabled, every assistant message
 * that completes is queued and spoken after the current one, newest last.
 * History never plays retroactively — only messages that finish while the
 * timeline is mounted are announced, and disabling keeps marking them seen so
 * re-enabling does not read the backlog.
 */
export function useAutoReadAloud({
  rows,
  environmentId,
  enabled,
  threadKey,
}: {
  readonly rows: ReadonlyArray<unknown>;
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly threadKey: string;
}) {
  const { enqueue, stop } = useSpokenMessage(environmentId);
  const announcedIdsRef = useRef<Set<string>>(new Set());
  const isFirstPassRef = useRef(true);
  const lastThreadKeyRef = useRef<string | null>(null);
  const stopRef = useRef(stop);

  // A thread switch is a new conversation: the backlog of the old one stays silent.
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  useEffect(() => {
    if (lastThreadKeyRef.current === threadKey) return;
    lastThreadKeyRef.current = threadKey;
    announcedIdsRef.current = new Set();
    isFirstPassRef.current = true;
    stopRef.current();
  }, [threadKey]);

  useEffect(() => {
    const newlyFinished: Array<{ readonly key: string; readonly text: string }> = [];
    for (const row of rows) {
      if (!isMessageRow(row)) continue;
      const message = row.message;
      // Streaming rows are left unseen: their completion is the announcement.
      if (message.role !== "assistant" || message.streaming) continue;
      if (message.text.trim().length === 0) continue;
      if (announcedIdsRef.current.has(message.id)) continue;
      announcedIdsRef.current.add(message.id);
      if (!isFirstPassRef.current) newlyFinished.push({ key: message.id, text: message.text });
    }
    isFirstPassRef.current = false;
    if (enabled) {
      for (const item of newlyFinished) enqueue(item);
    }
  }, [rows, enabled, enqueue]);
}

function isMessageRow(row: unknown): row is TimelineMessageRow {
  return (
    typeof row === "object" &&
    row !== null &&
    (row as { kind?: unknown }).kind === "message" &&
    typeof (row as { message?: unknown }).message === "object"
  );
}
