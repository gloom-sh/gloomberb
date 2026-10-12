import type { ChatChannel, ChatUserSummary } from "../../../api-client";
import { teamStore } from "../cloud/team/store";
import { formatChatPaneTitle } from "./channel-labels";

/** What the chat controller holds about one conversation, read without a request. */
export interface ChatConversationState {
  channel: ChatChannel;
  unreadCount: number;
  /** Newest message on this device, or when a DM started; -Infinity when unknown. */
  lastActivityAt: number;
}

/** The signed-in account and its conversations, as the chat controller holds them. */
export interface ChatConversationList {
  userId: string;
  states: ChatConversationState[];
}

export type ChatConversationKind = "channel" | "team" | "direct" | "group";

export interface ChatConversation {
  channelId: string;
  kind: ChatConversationKind;
  /** As the Chat pane titles it: #general, MD·#general, @alice, a group's name. */
  title: string;
  /** Muted beside the title: a DM's full name, a group's members, a channel's team. */
  name: string | null;
  /** The other person's username in a DM, lower case. */
  username: string | null;
  unreadCount: number;
  lastActivityAt: number;
  /** Position in the Chat sidebar: channels, then team channels, then DMs. */
  order: number;
  /** What the conversation is called, lower case: channel, username, full name, group name. */
  names: string[];
  /** Every word a typed word may start, lower case. */
  words: string[];
}

/** The empty bar is a browse list of everything; chat gets a few rows of it. */
const EMPTY_QUERY_CONVERSATION_LIMIT = 4;
/** Typing "messages" or "chat" asks for the list itself, so it gets more. */
const LISTING_CONVERSATION_LIMIT = 15;
const SEARCH_CONVERSATION_LIMIT = 8;
/** Below this many characters a match says little, so unread conversations lead. */
const SHORT_QUERY_LENGTH = 3;

/** Words that, typed alone, ask for the conversations rather than one of them. */
const LISTING_WORDS = new Set([
  "chat",
  "chats",
  "message",
  "messages",
  "conversation",
  "conversations",
  "dm",
  "dms",
]);

const WORD = /[\p{L}\p{N}]+/gu;

function wordsOf(value: string | null | undefined): string[] {
  return value?.toLowerCase().match(WORD) ?? [];
}

/** "Alice  Smith" and "alice smith" are the same name. */
function nameKey(value: string | null | undefined): string | null {
  const words = wordsOf(value);
  return words.length > 0 ? words.join(" ") : null;
}

function conversationKind(channel: ChatChannel): ChatConversationKind {
  if (channel.kind === "direct" || channel.kind === "group" || channel.kind === "team") return channel.kind;
  return "channel";
}

const KIND_ORDER: Record<ChatConversationKind, number> = { channel: 0, team: 1, direct: 2, group: 2 };

function memberLabel(member: ChatUserSummary): string | null {
  return member.username ? `@${member.username}` : member.displayName?.trim() || null;
}

function groupMembers(channel: ChatChannel, userId: string | null): string | null {
  const members = (channel.members ?? []).filter((member) => member.id !== userId);
  const labels = members.map(memberLabel).filter((label): label is string => !!label);
  if (labels.length === 0) return null;
  const shown = labels.slice(0, 3);
  return labels.length > shown.length ? `${shown.join(", ")} +${labels.length - shown.length}` : shown.join(", ");
}

function describe(
  channel: ChatChannel,
  userId: string | null,
): Pick<ChatConversation, "name" | "names" | "words"> & { username?: string | null } {
  switch (conversationKind(channel)) {
    case "direct": {
      const username = channel.dmUser?.username?.trim() || null;
      const displayName = channel.dmUser?.displayName?.trim() || null;
      return {
        // The title is @username when there is one; the full name says who that is.
        name: username && displayName && nameKey(displayName) !== nameKey(username) ? displayName : null,
        username: username?.replace(/^@+/, "").toLowerCase() ?? null,
        names: [nameKey(username), nameKey(displayName)].filter((name): name is string => !!name),
        words: [...wordsOf(username), ...wordsOf(displayName)],
      };
    }
    case "group": {
      const members = (channel.members ?? []).filter((member) => member.id !== userId);
      return {
        name: groupMembers(channel, userId),
        names: [nameKey(channel.name)].filter((name): name is string => !!name),
        words: [
          ...wordsOf(channel.name),
          ...members.flatMap((member) => [...wordsOf(member.username), ...wordsOf(member.displayName)]),
        ],
      };
    }
    case "team": {
      const team = teamStore.getTeam(channel.teamId ?? null);
      return {
        name: team?.name ?? null,
        names: [nameKey(channel.name)].filter((name): name is string => !!name),
        words: [
          ...wordsOf(channel.name),
          ...wordsOf(team?.name),
          ...wordsOf(team?.shortName),
        ],
      };
    }
    default:
      return {
        name: null,
        names: [nameKey(channel.name)].filter((name): name is string => !!name),
        words: wordsOf(channel.name),
      };
  }
}

/** The conversations the Chat sidebar lists, in its order, each named as the Chat pane names it. */
export function buildChatConversations(
  states: readonly ChatConversationState[],
  userId: string | null = null,
): ChatConversation[] {
  return states
    .map((state, index): ChatConversation => {
      const kind = conversationKind(state.channel);
      const { username = null, ...described } = describe(state.channel, userId);
      return {
        channelId: state.channel.id,
        kind,
        title: formatChatPaneTitle(state.channel, state.channel.id),
        username,
        unreadCount: state.unreadCount,
        lastActivityAt: state.lastActivityAt,
        order: KIND_ORDER[kind] * 100_000 + index,
        ...described,
      };
    })
    .sort((left, right) => left.order - right.order);
}

function isConversationWithPeople(conversation: ChatConversation): boolean {
  return conversation.kind === "direct" || conversation.kind === "group";
}

function compareUnreadFirst(left: ChatConversation, right: ChatConversation): number {
  return Number(right.unreadCount > 0) - Number(left.unreadCount > 0);
}

/** Newest activity first; two with nothing known tie. */
function compareActivity(left: ChatConversation, right: ChatConversation): number {
  const activity = right.lastActivityAt - left.lastActivityAt;
  return Number.isNaN(activity) ? 0 : activity;
}

/** Newest activity first; the sidebar's order breaks ties. */
function compareRecent(left: ChatConversation, right: ChatConversation): number {
  return compareActivity(left, right) || left.order - right.order;
}

/**
 * Unread conversations first, newest then most unread; then DMs and groups by
 * their last activity; then channels in the sidebar's order.
 */
function compareListing(left: ChatConversation, right: ChatConversation): number {
  const unread = compareUnreadFirst(left, right);
  if (unread !== 0) return unread;
  if (left.unreadCount > 0) {
    return compareActivity(left, right) || right.unreadCount - left.unreadCount || left.order - right.order;
  }
  const people = Number(isConversationWithPeople(right)) - Number(isConversationWithPeople(left));
  if (people !== 0) return people;
  return isConversationWithPeople(left) ? compareRecent(left, right) : left.order - right.order;
}

/**
 * How well typed words name a conversation: 3 when they are its name, 2 when
 * its name starts with them, 1 when each starts a word of it, 0 otherwise.
 */
function rankChatConversation(conversation: ChatConversation, query: string): number {
  const tokens = wordsOf(query);
  if (tokens.length === 0) return 0;
  const phrase = tokens.join(" ");
  if (conversation.names.includes(phrase)) return 3;
  if (conversation.names.some((name) => name.startsWith(phrase))) return 2;
  return tokens.every((token) => conversation.words.some((word) => word.startsWith(token))) ? 1 : 0;
}

export type ChatConversationQuery =
  | { kind: "recent" }
  | { kind: "listing" }
  | { kind: "search"; text: string };

/**
 * What the typed text asks for: nothing typed is the recent list, a word like
 * "messages" or "chat" on its own is the whole list, and "chat gen" searches
 * for "gen".
 */
export function parseChatConversationQuery(query: string): ChatConversationQuery {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "recent" };
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (!LISTING_WORDS.has(first.toLowerCase())) return { kind: "search", text: trimmed };
  return rest.length === 0 ? { kind: "listing" } : { kind: "search", text: rest.join(" ") };
}

/**
 * The conversations that answer the text in the command bar, best first.
 * With nothing typed: unread ones and the latest DMs, a few at most. Short
 * text puts unread matches first; longer text the closest names.
 */
export function selectChatConversations(
  conversations: readonly ChatConversation[],
  query: ChatConversationQuery,
): ChatConversation[] {
  if (query.kind === "recent") {
    return conversations
      .filter((conversation) => conversation.unreadCount > 0 || isConversationWithPeople(conversation))
      .sort(compareListing)
      .slice(0, EMPTY_QUERY_CONVERSATION_LIMIT);
  }
  if (query.kind === "listing") {
    return [...conversations].sort(compareListing).slice(0, LISTING_CONVERSATION_LIMIT);
  }
  const shortQuery = query.text.replace(/[#@\s]/g, "").length < SHORT_QUERY_LENGTH;
  return conversations
    .map((conversation) => ({ conversation, rank: rankChatConversation(conversation, query.text) }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => {
      const unread = compareUnreadFirst(left.conversation, right.conversation);
      if (shortQuery && unread !== 0) return unread;
      return right.rank - left.rank || unread || compareRecent(left.conversation, right.conversation);
    })
    .slice(0, SEARCH_CONVERSATION_LIMIT)
    .map((entry) => entry.conversation);
}
