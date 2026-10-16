import type { ChatChannel, ChatMentionCandidate, ChatMessage } from "../../../../api-client";
import { isDiscordGhost } from "../ghost-user";

export interface ChatMentionSuggestion {
  username: string;
  displayName?: string | null;
}

interface ChatMentionTrigger {
  start: number;
  end: number;
  query: string;
}

const MENTION_TRIGGER_RE = /(^|[\s([{<,.;:!?])@([\p{L}\p{N}_]{0,30})$/u;
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
  candidates,
}: {
  activeChannel: ChatChannel | undefined;
  currentUserId: string | null | undefined;
  messages: ChatMessage[];
  candidates?: ChatMentionCandidate[];
}): ChatMentionSuggestion[] {
  if (activeChannel?.kind === "direct") return [];
  const time = (value: string | null) => value ? Date.parse(value) || 0 : 0;
  const people = new Map((candidates ?? []).map((person) => [person.id, {
    ...person,
    activity: time(person.channelActivityAt),
    conversation: time(person.conversationActivityAt),
  }]));
  for (const message of messages) {
    if (activeChannel && message.channelId !== activeChannel.id) continue;
    const user = message.user;
    const username = normalizeUsername(user.username);
    if (!username || user.id === currentUserId || isDiscordGhost(user)) continue;
    const existing = people.get(user.id);
    // Private membership is authoritative, including removals. A newly
    // received public message itself makes its author visible in this channel.
    const publicChannel = activeChannel && (!activeChannel.kind || activeChannel.kind === "public");
    if (candidates !== undefined && !existing && !publicChannel) continue;
    people.set(user.id, {
      id: user.id,
      username: existing?.username ?? username,
      displayName: existing?.displayName ?? user.displayName,
      channelActivityAt: null,
      conversationActivityAt: null,
      activity: Math.max(existing?.activity ?? 0, time(message.createdAt)),
      conversation: existing?.conversation ?? 0,
    });
  }
  const seen = new Set<string>();
  return [...people.values()]
    .sort((a, b) => b.activity - a.activity || b.conversation - a.conversation || a.username.localeCompare(b.username))
    .filter((person) => {
      const key = person.username.toLowerCase();
      if (person.id === currentUserId || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ username, displayName }) => ({ username, displayName }));
}

export function filterMentionSuggestions(
  suggestions: ChatMentionSuggestion[],
  query: string,
  limit = MAX_MENTION_SUGGESTIONS,
): ChatMentionSuggestion[] {
  const normalizedQuery = normalizeUsername(query)?.toLowerCase() ?? "";
  const matches: ChatMentionSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (matches.length >= Math.min(limit, MAX_MENTION_SUGGESTIONS)) break;
    if (!normalizedQuery
      || suggestion.username.toLowerCase().startsWith(normalizedQuery)
      || suggestion.displayName?.toLowerCase().split(/\s+/).some((word) => word.startsWith(normalizedQuery))) {
      matches.push(suggestion);
    }
  }
  return matches;
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
