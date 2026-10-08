import type { ChatUserSummary } from "../../../api-client";

/**
 * A person on the Gloom Discord with no linked Gloom account. Their messages
 * show in the channel, but there is no profile to open and no one to message.
 */
export function isDiscordGhost(user: Pick<ChatUserSummary, "accountType"> | null | undefined): boolean {
  return user?.accountType === "discord";
}

/** The name a message is signed with: the username, or for a ghost that has none the Discord name it carries. */
export function chatAuthorName(user: Pick<ChatUserSummary, "username" | "displayName" | "accountType">): string {
  return user.username ?? ((isDiscordGhost(user) && user.displayName?.trim()) || "anon");
}
