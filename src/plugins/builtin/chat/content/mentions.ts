import type { ChatChannel, ChatMessage } from "../../../../api-client";
import { isDiscordGhost } from "../ghost-user";

export interface ChatMentionSuggestion {
  username: string;
}

interface ChatMentionTrigger {
  start: number;
  end: number;
  query: string;
}

const MENTION_TRIGGER_RE = /(^|[\s([{<,.;:!?])@([A-Za-z0-9_]{0,30})$/;
const MAX_MENTION_SUGGESTIONS = 5;

function normalizeUsername(username: string | null | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, "");
  return normalized ? normalized : null;
}

export function detectChatMentionTrigger(
  draft: string,
  cursorOffset: number,
): ChatMentionTrigger | null {
  const cursor = Math.max(0, Math.min(cursorOffset, draft.length));
  const beforeCursor = draft.slice(0, cursor);
  const match = beforeCursor.match(MENTION_TRIGGER_RE);
  if (!match) return null;
  const query = match[2] ?? "";
  const start = beforeCursor.length - query.length - 1;
  return { start, end: cursor, query };
}

export function buildRecentMentionSuggestions({
  activeChannel,
  currentUserId,
  messages,
  limit = MAX_MENTION_SUGGESTIONS,
}: {
  activeChannel: ChatChannel | undefined;
  currentUserId: string | null | undefined;
  messages: ChatMessage[];
  limit?: number;
}): ChatMentionSuggestion[] {
  if (activeChannel?.kind === "direct") return [];
  const seen = new Set<string>();
  const suggestions: ChatMentionSuggestion[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const user = messages[index]?.user;
    const username = normalizeUsername(user?.username);
    if (!user || !username || user.id === currentUserId || isDiscordGhost(user)) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ username });
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

export function filterMentionSuggestions(
  suggestions: ChatMentionSuggestion[],
  query: string,
  limit = MAX_MENTION_SUGGESTIONS,
): ChatMentionSuggestion[] {
  const normalizedQuery = normalizeUsername(query)?.toLowerCase() ?? "";
  return suggestions
    .filter((suggestion) => !normalizedQuery || suggestion.username.toLowerCase().startsWith(normalizedQuery))
    .slice(0, limit);
}

export function applyMentionSuggestion(
  draft: string,
  trigger: ChatMentionTrigger,
  suggestion: ChatMentionSuggestion,
): { draft: string; cursorOffset: number } {
  const before = draft.slice(0, trigger.start);
  const after = draft.slice(trigger.end);
  const mention = `@${suggestion.username}`;
  const suffix = after.length === 0 || !/^\s/.test(after) ? " " : "";
  const nextDraft = `${before}${mention}${suffix}${after}`;
  return {
    draft: nextDraft,
    cursorOffset: before.length + mention.length + suffix.length,
  };
}
