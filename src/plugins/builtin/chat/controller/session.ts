import type { ChannelRuntimeState } from "./state";
import type { ChatSessionUser } from "./persistence";
import { clearSignedOutChannelState } from "./lifecycle";
import { normalizeChatUsername } from "./utils";

export type ChatApiSession = {
  id: string;
  username?: string | null;
  name?: string | null;
  emailVerified?: boolean | null;
  plan?: "free" | "pro";
};

export function getSessionIdentity(user: ChatSessionUser | null): string {
  return `${user?.id ?? ""}:${normalizeChatUsername(user?.username) ?? ""}`;
}

export function sessionUserFromApiSession(session: ChatApiSession): ChatSessionUser {
  return {
    id: session.id,
    username: session.username ?? session.name ?? "account",
    emailVerified: !!session.emailVerified,
    plan: session.plan,
  };
}

export function clearSignedOutSessionChannels(channels: Iterable<ChannelRuntimeState>): void {
  for (const channel of channels) {
    clearSignedOutChannelState(channel);
  }
}

export function markChannelsViewedForIdentityChange(
  channels: Iterable<[string, ChannelRuntimeState]>,
  persistChannelState: (channelId: string) => void,
): void {
  for (const [channelId, channel] of channels) {
    channel.lastViewedMessageId = channel.messages[channel.messages.length - 1]?.id ?? null;
    persistChannelState(channelId);
  }
}
