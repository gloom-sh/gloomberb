import type { ChatConversation } from "../conversations";
import { DEFAULT_CHAT_CHANNEL_ID, normalizeChannelId } from "../channels";

export interface ShareTarget {
  channelId: string;
  /** As the Chat pane titles it: #everyone, MD·#general, @alice. */
  label: string;
  /** Muted beside it: a DM's full name, a group's members, a channel's team. */
  description?: string;
}

/**
 * Where a pane's picture can go: every conversation the Chat sidebar lists,
 * in its order (public channels first). #everyone is always offered, even
 * before the channel list has loaded.
 */
export function shareTargets(conversations: readonly ChatConversation[]): ShareTarget[] {
  const targets = conversations.map((conversation): ShareTarget => ({
    channelId: conversation.channelId,
    label: conversation.title,
    ...(conversation.name ? { description: conversation.name } : {}),
  }));
  if (!targets.some((target) => target.channelId === DEFAULT_CHAT_CHANNEL_ID)) {
    targets.unshift({ channelId: DEFAULT_CHAT_CHANNEL_ID, label: `#${DEFAULT_CHAT_CHANNEL_ID}` });
  }
  return targets;
}

/** The channel last used in chat when it is still offered, otherwise #everyone. */
export function defaultShareTarget(targets: readonly ShareTarget[], lastUsedChannelId: string | null | undefined): string {
  const lastUsed = normalizeChannelId(lastUsedChannelId);
  return targets.some((target) => target.channelId === lastUsed) ? lastUsed : DEFAULT_CHAT_CHANNEL_ID;
}
