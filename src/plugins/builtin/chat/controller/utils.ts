import type { ChatMessage } from "../../../../api-client";
import { t, tf } from "../../../../i18n";

const ISO_TIMESTAMP_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
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

function formatMessageSnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

export function formatMentionToast(message: ChatMessage): string {
  const author = message.user.username || t("Someone");
  const snippet = formatMessageSnippet(message.content);
  if (!snippet) {
    return tf("@{author} mentioned you in chat.", { author });
  }
  return tf("@{author} mentioned you: {snippet}", { author, snippet });
}

export function formatReplyToast(message: ChatMessage): string {
  const author = message.user.username || t("Someone");
  const snippet = formatMessageSnippet(message.content);
  if (!snippet) {
    return tf("@{author} replied to you.", { author });
  }
  return tf("@{author} replied to you: {snippet}", { author, snippet });
}

export function formatChannelToast(message: ChatMessage, direct = false): string {
  const author = message.user.username || t("Someone");
  const snippet = formatMessageSnippet(message.content);
  if (direct && snippet) return snippet;
  return snippet ? `@${author}: ${snippet}` : tf("@{author} sent a message.", { author });
}

export function isLegacyTimestampCursor(cursor: string | null): boolean {
  return !!cursor && ISO_TIMESTAMP_CURSOR.test(cursor);
}

export function getLatestMessageId(messages: ChatMessage[]): string | null {
  return messages[messages.length - 1]?.id ?? null;
}

export function resolveHydratedCursor(messages: ChatMessage[], persistedCursor: string | null): string | null {
  const transcriptCursor = getLatestMessageId(messages);
  if (!transcriptCursor) return null;
  if (!persistedCursor || isLegacyTimestampCursor(persistedCursor)) {
    return persistedCursor ?? transcriptCursor;
  }
  return persistedCursor === transcriptCursor ? persistedCursor : transcriptCursor;
}

export function createClientMessageId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  return randomUUID ?? `local:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return a.createdAt.localeCompare(b.createdAt);
}
