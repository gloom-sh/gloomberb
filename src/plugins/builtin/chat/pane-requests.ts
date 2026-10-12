import { useSyncExternalStore } from "react";

/**
 * Something a Chat pane should do once it has the keyboard, asked for from
 * outside it: the command bar opens a conversation to write in, or the New DM
 * dialog. The pane that is focused on that conversation takes it.
 */
export type ChatPaneRequest =
  | { action: "compose"; channelId: string }
  | { action: "new-dm" };

interface PendingChatPaneRequest {
  request: ChatPaneRequest;
  at: number;
}

/** A request no pane took by then (the pane never opened) must not fire later. */
const REQUEST_TTL_MS = 10_000;

let pending: PendingChatPaneRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestChatPaneAction(request: ChatPaneRequest, now = Date.now()): void {
  pending = { request, at: now };
  emit();
}

/**
 * Hands the request to the pane on `channelId` and clears it. Null when there
 * is none for that pane or it went stale.
 */
export function takeChatPaneRequest(channelId: string, now = Date.now()): ChatPaneRequest | null {
  if (!pending) return null;
  const { request, at } = pending;
  if (now - at > REQUEST_TTL_MS) {
    pending = null;
    emit();
    return null;
  }
  if (request.action === "compose" && request.channelId !== channelId) return null;
  pending = null;
  emit();
  return request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The request waiting for a pane, so a pane can take it once it has the keyboard. */
export function usePendingChatPaneRequest(): ChatPaneRequest | null {
  return useSyncExternalStore(subscribe, () => pending?.request ?? null);
}
