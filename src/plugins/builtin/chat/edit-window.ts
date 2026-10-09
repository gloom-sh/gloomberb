import type { ChatMessage } from "../../../api-client";

export const CHAT_MESSAGE_EDIT_WINDOW_MS = 15 * 60_000;
export const CHAT_MESSAGE_EDIT_WINDOW_LABEL = "15 minutes";

export function isWithinChatMessageEditWindow(message: ChatMessage, nowMs = Date.now()): boolean {
  const createdMs = Date.parse(message.createdAt);
  return Number.isFinite(createdMs) && nowMs - createdMs <= CHAT_MESSAGE_EDIT_WINDOW_MS;
}

/** What the server answers (409) to an edit of a message written on Discord. */
export const DISCORD_MESSAGE_EDIT_NOTICE = "This message was sent on Discord. Edit it there.";

/** A message written on Discord is edited there; the server refuses an edit of it. */
export function isEditableOnGloom(message: ChatMessage): boolean {
  return message.origin !== "discord";
}

export function findLatestEditableChatMessage(
  messages: ChatMessage[],
  userId: string | null | undefined,
  nowMs = Date.now(),
): ChatMessage | null {
  if (!userId) return null;
  // Only your latest message can be edited, so a Discord one in that place leaves nothing to edit.
  const latest = [...messages]
    .reverse()
    .find((message) => message.user.id === userId && !message.clientStatus);
  return latest && isEditableOnGloom(latest) && isWithinChatMessageEditWindow(latest, nowMs) ? latest : null;
}
