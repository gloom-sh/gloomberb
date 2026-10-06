import type { ChatMessage } from "../../../../api-client";
import { t, tf } from "../../../../i18n";
import { chatTextWithImages } from "../attachments/model";

const USERNAME_MENTION = /(^|[^A-Za-z0-9_])@([A-Za-z][A-Za-z0-9_]{2,29})(?![A-Za-z0-9_])/g;

export function normalizeChatUsername(username: string | null | undefined): string | null {
  const trimmed = username?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function chatMessageMentionsUsername(content: string, username: string): boolean {
  USERNAME_MENTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USERNAME_MENTION.exec(content)) !== null) {
    if ((match[2] ?? "").toLowerCase() === username) {
      return true;
    }
  }
  return false;
}

/** The message as one short line, its images as `[image]` in front of the text. */
function formatMessageSnippet(message: ChatMessage): string {
  const normalized = chatTextWithImages(message.content, message.attachments?.length ?? 0).replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

export function formatMentionToast(message: ChatMessage): string {
  const author = message.user.username || t("Someone");
  const snippet = formatMessageSnippet(message);
  if (!snippet) {
    return tf("@{author} mentioned you in chat.", { author });
  }
  return tf("@{author} mentioned you: {snippet}", { author, snippet });
}

export function formatReplyToast(message: ChatMessage): string {
  const author = message.user.username || t("Someone");
  const snippet = formatMessageSnippet(message);
  if (!snippet) {
    return tf("@{author} replied to you.", { author });
  }
  return tf("@{author} replied to you: {snippet}", { author, snippet });
}

export function formatChannelToast(message: ChatMessage, direct = false): string {
  const author = message.user.username || t("Someone");
  const snippet = formatMessageSnippet(message);
  if (direct && snippet) return snippet;
  return snippet ? `@${author}: ${snippet}` : tf("@{author} sent a message.", { author });
}

export function getLatestMessageId(messages: ChatMessage[]): string | null {
  return messages[messages.length - 1]?.id ?? null;
}

export function createClientMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  return randomUUID ?? `local:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return a.createdAt.localeCompare(b.createdAt);
}
