import type { ChatPaneLink } from "../chat-pane-link";
import type { PublicPortfolioAnalytics } from "./account";

/**
 * What stands behind a chat account. `discord` is a person on the Gloom
 * Discord who has not linked a Gloom account: a ghost with no profile, no DMs.
 * A server that predates the field leaves it out, which reads as a human.
 */
export type ChatAccountType = "human" | "managed_llm" | "discord";

/** Where a message was written. A message without one came from the app. */
export type ChatMessageOrigin = "app" | "discord";

/** A badge an account earns in chat: `team` for Gloom staff, `pro` with Pro access. */
export type ChatUserBadge = "team" | "pro";

export interface ChatUserSummary {
  id: string;
  /** A person, a managed assistant (Gloombot), or a Discord user bridged into public channels. */
  accountType?: ChatAccountType;
  username: string | null;
  displayName: string;
  bio?: string | null;
  company?: string | null;
  title?: string | null;
  profilePublic?: boolean;
  acceptUnknownDms?: boolean;
  portfolioAnalytics?: PublicPortfolioAnalytics | null;
  /** Badges the account earns. A server that predates them, or a person with none, leaves this out. */
  badges?: ChatUserBadge[];
  /**
   * The person's current offset from UTC in minutes, as their app last
   * reported it: left out while they keep their local time hidden.
   */
  utcOffsetMinutes?: number;
  /** The desks (equities, options, ...) the person chose to show; left out unless they did. */
  desks?: string[];
}

/**
 * An image in a chat message, as the server stored it: `width`, `height`,
 * `size` and `mime` describe the stored copy, not the upload. `url` opens in an
 * <img> without headers; signed links last one to two hours, and a fresh copy
 * of the message carries a fresh one.
 */
export interface ChatAttachment {
  id: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  url: string;
}

/** Someone who reacted, as a reaction lists the first few. */
export interface ChatReactionUser {
  id: string;
  username: string | null;
  displayName: string;
  accountType?: ChatAccountType | null;
}

/**
 * One emoji on a message: how many reacted, whether you did, and the first
 * few who did, oldest first. `emoji` is the character, or `:name:` for a
 * custom Discord server emoji.
 */
export interface ChatReaction {
  emoji: string;
  count: number;
  me: boolean;
  users?: ChatReactionUser[];
}

/** A message's reactions as they stand after a change, from the `chat.reactions` frame or a reaction request. */
export interface ChatReactionsUpdate {
  channelId: string;
  messageId: string;
  reactions: ChatReaction[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  replyToId: string | null;
  createdAt: string;
  editedAt?: string | null;
  user: ChatUserSummary;
  origin?: ChatMessageOrigin;
  replyTo?: {
    content: string;
    user: { id?: string; username: string };
    /** Images on the quoted message. */
    attachmentCount?: number;
  } | null;
  /** Images in display order. A server that predates them leaves this out. */
  attachments?: ChatAttachment[];
  /**
   * Emoji reactions in the order they first appeared. Message lists from a
   * server that knows reactions always carry it; a live copy of a message
   * (an edit) leaves it out, and the reactions held stay.
   */
  reactions?: ChatReaction[];
  /**
   * Only on the author's copy of a public message whose images are still being
   * checked ("pending") or could not be checked ("failed"). Nobody else has the
   * message yet.
   */
  attachmentReview?: "pending" | "failed";
  /** What the message opens in the terminal (a Gloom Wire story or calendar). Only the server sets it. */
  paneLink?: ChatPaneLink;
  /**
   * An announcement Gloom posted, drawn as one. Only the server sets it, and
   * only on one that still stands: a retracted announcement is the removal
   * placeholder without it.
   */
  announcement?: true;
  clientStatus?: "sending" | "failed";
  clientError?: string | null;
  /** The idempotency key a local send went out with, so a retry repeats it. */
  clientMessageId?: string;
}

/** Whether this account is tied to a person on the Gloom Discord, and whether its public messages go there. */
export interface ChatDiscordLink {
  linked: boolean;
  discordUsername?: string;
  mirror: boolean;
  /** False when the server has linking switched off. A server that predates the field is available. */
  available: boolean;
}

export interface ChatChannel {
  id: string;
  name: string;
  kind?: "public" | "direct" | "group" | "team";
  created_at: string;
  teamId?: string;
  dmUser?: ChatUserSummary | null;
  members?: ChatUserSummary[];
  /**
   * When the newest message you can see in a direct or group conversation was
   * sent; null when it has none. Absent from channels of other kinds and from
   * servers that do not report it.
   */
  lastMessageAt?: string | null;
}

/** Minimal identities scoped by the server to this channel and existing DMs. */
export interface ChatMentionCandidate {
  id: string;
  username: string;
  displayName: string | null;
  channelActivityAt: string | null;
  conversationActivityAt: string | null;
}

export interface ChatChannelState {
  channelId: string;
  notificationsEnabled: boolean;
  lastReadMessageId: string | null;
  unreadCount: number;
}

export interface ChatNotification {
  id: string;
  type: "reply" | "mention" | "channel";
  channelId: string;
  messageId: string;
  createdAt: string;
  message: ChatMessage;
}

export interface ChatStateResponse {
  channels: ChatChannel[];
  onlineCount: number;
  channelStates: ChatChannelState[];
  notifications: ChatNotification[];
}
