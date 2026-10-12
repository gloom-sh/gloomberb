import type { ChatUserSummary } from "../../../api-client";

/**
 * A person on the Gloom Discord with no linked Gloom account. Their messages
 * show in the channel, but there is no profile to open and no one to message.
 */
export function isDiscordGhost(user: Pick<ChatUserSummary, "accountType"> | null | undefined): boolean {
  return user?.accountType === "discord";
}

/**
 * A managed assistant (Gloombot, Gloom Wire, the AI desk personas): an account
 * Gloom runs, not a person. Wherever it signs a message it carries a Bot badge.
 */
export function isManagedBot(user: Pick<ChatUserSummary, "accountType"> | null | undefined): boolean {
  return user?.accountType === "managed_llm";
}

/**
 * A reply quotes its author by name only, so whether that author is a managed
 * assistant comes from the users the pane has seen.
 */
export function isQuotedAuthorManagedBot(
  quoted: { user: { username?: string | null } },
  userByUsername: ReadonlyMap<string, ChatUserSummary>,
): boolean {
  const username = quoted.user.username?.toLowerCase();
  return !!username && isManagedBot(userByUsername.get(username));
}

/** The name a message is signed with: the username, or for a ghost that has none the Discord name it carries. */
export function chatAuthorName(user: Pick<ChatUserSummary, "username" | "displayName" | "accountType">): string {
  return user.username ?? ((isDiscordGhost(user) && user.displayName?.trim()) || "anon");
}
