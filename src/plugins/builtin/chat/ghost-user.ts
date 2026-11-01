import type { ChatMessage, ChatUserSummary } from "../../../api-client";

/**
 * A person on the Gloom Discord with no linked Gloom account. Their messages
 * show in the channel, but there is no profile to open and no one to message.
 */
export function isDiscordGhost(user: Pick<ChatUserSummary, "accountType"> | null | undefined): boolean {
  return user?.accountType === "discord";
}

/**
 * A managed assistant (Gloombot, Gloom Wire, the AI desk personas): an account
 * Gloom runs, not a person. Wherever it signs a message it carries the bot's icon.
 */
export function isManagedBot(user: Pick<ChatUserSummary, "accountType"> | null | undefined): boolean {
  return user?.accountType === "managed_llm";
}

/** Gloom Wire: the account that posts headlines, the day's calendar and pull requests into the topic channels. */
const GLOOM_WIRE_USER_ID = "managed-llm-gloomwire";

/** A Gloom Wire post: there to read, so unread only when it mentions you. */
export function isGloomWire(user: Pick<ChatUserSummary, "id"> | null | undefined): boolean {
  return user?.id === GLOOM_WIRE_USER_ID;
}

/**
 * A reply quotes its author by name only, so whether that author is a managed
 * assistant comes from the users the pane has seen. A quoted announcement is
 * Gloom speaking, not a bot, when the pane has it to tell.
 */
export function isQuotedAuthorManagedBot(
  quoted: { user: { username?: string | null } },
  userByUsername: ReadonlyMap<string, ChatUserSummary>,
  /** The quoted message, when the pane holds it. */
  findQuoted?: () => Pick<ChatMessage, "announcement"> | null | undefined,
): boolean {
  const username = quoted.user.username?.toLowerCase();
  return !!username && isManagedBot(userByUsername.get(username)) && !findQuoted?.()?.announcement;
}

/** A message among those the pane holds, by id. */
export function heldMessage(messages: readonly ChatMessage[], id: string | null | undefined): ChatMessage | null {
  return id ? messages.find((message) => message.id === id) ?? null : null;
}

/** The name a message is signed with: the username, or for a ghost that has none the Discord name it carries. */
export function chatAuthorName(user: Pick<ChatUserSummary, "username" | "displayName" | "accountType">): string {
  return user.username ?? ((isDiscordGhost(user) && user.displayName?.trim()) || "anon");
}
