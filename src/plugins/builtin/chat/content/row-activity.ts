import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../../api-client";
import { useShortcut } from "../../../../react/input";

/** How long a message the reader was sent to (a notification, a quoted reply) stays marked. */
export const MESSAGE_HIGHLIGHT_MS = 2000;

const MESSAGE_ID_ATTRIBUTE = "data-gloom-chat-message-id";
const TRANSCRIPT_ROLE = "chat-transcript";

interface PointerMove {
  target?: unknown;
  pixelX?: number;
  pixelY?: number;
}

/**
 * The two marks a row can carry besides the keyboard selection, each on at most
 * one row: the one under the pointer (its band and its Reply button) and the
 * one the reader was sent to. Neither may outlive its reason.
 *
 * Both drop when the channel changes, when a message arrives or when the pane
 * loses focus; the highlight also on a key press or a click, and the hover when
 * the pointer leaves the transcript, the list scrolls under it or a key moves
 * focus. The highlight fades out on its own after MESSAGE_HIGHLIGHT_MS.
 *
 * The terminal reports the row under the pointer itself (`setHoveredIdx` from the
 * rows); on the desktop the transcript reports pointer moves (`onPointerMove`).
 */
export function useChatRowActivity({
  channelId,
  focused,
  messages,
  nativePaneChrome,
}: {
  channelId: string;
  focused: boolean;
  messages: ChatMessage[];
  nativePaneChrome: boolean | undefined;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  // A new object for each request, so asking again for the same message starts its time over.
  const [highlight, setHighlight] = useState<{ id: string } | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const latestMessageId = messages[messages.length - 1]?.id ?? null;

  const clearHover = useCallback(() => setHoveredIdx(null), []);
  const clearHighlight = useCallback(() => setHighlight(null), []);
  const highlightMessage = useCallback((messageId: string) => setHighlight({ id: messageId }), []);

  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), MESSAGE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  // A message arrives, or another channel opens: whatever was marked belongs to a list that is gone.
  useEffect(() => {
    setHoveredIdx(null);
    setHighlight(null);
  }, [channelId, latestMessageId]);
  useEffect(() => {
    if (focused) return;
    setHoveredIdx(null);
    setHighlight(null);
  }, [focused]);

  // Rows are indexed, so a list that grows or shrinks at its top moves them.
  const firstMessageId = messages[0]?.id ?? null;
  useEffect(() => {
    setHoveredIdx(null);
  }, [firstMessageId]);

  // Any key: the reader has moved on from what was highlighted, and focus may move.
  const anythingMarkedRef = useRef(false);
  anythingMarkedRef.current = hoveredIdx !== null || highlight !== null;
  useShortcut(() => {
    if (!anythingMarkedRef.current) return;
    setHoveredIdx(null);
    setHighlight(null);
  }, { enabled: focused, phase: "before", allowEditable: true });

  // The pointer on the desktop: the row it moves over is hovered, and only a move
  // does that, not rows sliding under a pointer that stays still.
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const transcriptRef = useRef<Element | null>(null);
  const onPointerMove = useCallback((event: PointerMove) => {
    const point = { x: event.pixelX ?? 0, y: event.pixelY ?? 0 };
    const last = lastPointRef.current;
    if (last && last.x === point.x && last.y === point.y) return;
    lastPointRef.current = point;
    const row = (event.target as Element | null)?.closest?.(`[${MESSAGE_ID_ATTRIBUTE}]`) ?? null;
    transcriptRef.current = row?.closest?.(`[data-gloom-role="${TRANSCRIPT_ROLE}"]`) ?? null;
    const messageId = row?.getAttribute(MESSAGE_ID_ATTRIBUTE);
    const index = messageId ? messagesRef.current.findIndex((message) => message.id === messageId) : -1;
    setHoveredIdx(index >= 0 ? index : null);
  }, []);

  const hovering = nativePaneChrome === true && hoveredIdx !== null;
  useEffect(() => {
    if (!hovering) return;
    // The browser says what is under the pointer when it moves; leaving the window
    // or the pane, or the window losing focus, is the one thing it can fail to say.
    const onMove = (event: MouseEvent) => {
      const root = transcriptRef.current;
      if (!root || !root.contains(event.target as Node | null)) setHoveredIdx(null);
    };
    const onOut = (event: MouseEvent) => {
      if (!event.relatedTarget) setHoveredIdx(null);
    };
    const clear = () => setHoveredIdx(null);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseout", onOut, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseout", onOut, true);
      window.removeEventListener("blur", clear);
    };
  }, [hovering]);

  return {
    clearHighlight,
    clearHover,
    highlightMessage,
    highlightedMessageId: highlight?.id ?? null,
    hoveredIdx,
    onPointerMove,
    setHoveredIdx,
  };
}
