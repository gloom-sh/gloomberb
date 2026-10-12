import type { ChatChannel, ChatMessage, ChatUserSummary } from "../../../../api-client";
import { isDiscordGhost } from "../ghost-user";

/** Who a name can open a profile for or start a conversation with: Discord ghosts are left out. */
export function buildChatUserByUsername(
  channels: ChatChannel[],
  messages: ChatMessage[],
): Map<string, ChatUserSummary> {
  const map = new Map<string, ChatUserSummary>();
  for (const message of messages) {
    const username = message.user.username?.toLowerCase();
    if (username && !isDiscordGhost(message.user)) map.set(username, message.user);
  }
  for (const channel of channels) {
    for (const member of channel.members ?? []) {
      const username = member.username?.toLowerCase();
      if (username) map.set(username, member);
    }
    const dmUsername = channel.dmUser?.username?.toLowerCase();
    if (dmUsername && channel.dmUser) map.set(dmUsername, channel.dmUser);
  }
  return map;
}
