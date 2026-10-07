import { useEffect, useReducer } from "react";
import type { ChatMessage } from "../../../../api-client";
import { toTimestampMillis } from "../../../../utils/timestamp";

/**
 * A message you just sent looks sent. Only when the send is still pending after this long does it
 * fall back to the dim "sending..." state, so a dead connection stays visible.
 */
export const SLOW_SEND_THRESHOLD_MS = 8_000;

function isSlowPendingSend(msg: ChatMessage, now: number): boolean {
  if (msg.clientStatus !== "sending") return false;
  const startedAt = toTimestampMillis(msg.createdAt);
  return Number.isNaN(startedAt) || now - startedAt >= SLOW_SEND_THRESHOLD_MS;
}

/**
 * True once a pending send has been waiting past the threshold. Rows that are not pending schedule
 * nothing; a pending row sets one timer for the moment it turns slow and clears it on unmount or
 * when the send resolves.
 */
export function useSlowPendingSend(msg: ChatMessage): boolean {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const pending = msg.clientStatus === "sending";
  const slow = isSlowPendingSend(msg, Date.now());

  useEffect(() => {
    if (!pending || slow) return;
    const remaining = toTimestampMillis(msg.createdAt) + SLOW_SEND_THRESHOLD_MS - Date.now();
    const timer = setTimeout(rerender, Math.max(remaining, 0));
    return () => clearTimeout(timer);
  }, [pending, slow, msg.createdAt]);

  return slow;
}
