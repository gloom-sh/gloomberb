import type { ChatChannel } from "../../../api-client";

/** The recency of a conversation nothing is known about: it sorts after every dated one. */
export const NO_ACTIVITY = Number.NEGATIVE_INFINITY;

export function isPeopleConversation(channel: Pick<ChatChannel, "kind">): boolean {
  return channel.kind === "direct" || channel.kind === "group";
}

function timeOf(value: string | null | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : NO_ACTIVITY;
}

/**
 * When a conversation last had a message, in ms, or {@link NO_ACTIVITY}: the
 * newest of what the server reported for it and the newest message this device
 * holds, sent or received. The server's value is what dates a DM whose
 * messages are not loaded yet. A server that reports nothing at all (the field
 * is absent, not null) leaves a DM or group dated from when it was started, the
 * best bound there is; one that says null is saying the conversation is empty.
 */
export function conversationActivityAt(
  channel: ChatChannel,
  held: { messageAt?: string | undefined; pendingAt?: string | undefined } = {},
): number {
  const known = Math.max(timeOf(channel.lastMessageAt), timeOf(held.messageAt), timeOf(held.pendingAt));
  if (known !== NO_ACTIVITY) return known;
  return isPeopleConversation(channel) && channel.lastMessageAt === undefined ? timeOf(channel.created_at) : NO_ACTIVITY;
}

/** Newest first; a conversation with no known activity after every other, and equal to another. */
export function compareConversationActivity(left: number, right: number): number {
  const leftKnown = left !== NO_ACTIVITY && !Number.isNaN(left);
  const rightKnown = right !== NO_ACTIVITY && !Number.isNaN(right);
  if (leftKnown && rightKnown) return right - left;
  return Number(rightKnown) - Number(leftKnown);
}

/**
 * The items newest first. Items with the same or no known activity keep the
 * order they came in.
 */
export function sortByConversationActivity<T>(items: readonly T[], activityOf: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, at: activityOf(item) }))
    .sort((left, right) => compareConversationActivity(left.at, right.at) || left.index - right.index)
    .map((entry) => entry.item);
}

/** Newest message time (ms) of each direct and group conversation that has one, by channel id. */
export type ConversationActivity = Readonly<Record<string, number>>;

export function activityOfChannel(activity: ConversationActivity, channel: Pick<ChatChannel, "id">): number {
  return activity[channel.id] ?? NO_ACTIVITY;
}

/**
 * The channels with the direct and group conversations in recency order, each
 * in a slot a conversation already held: every other channel stays where it is.
 */
export function orderConversationChannels<T extends Pick<ChatChannel, "id" | "kind">>(
  channels: readonly T[],
  activity: ConversationActivity,
): T[] {
  const ordered = sortByConversationActivity(
    channels.filter(isPeopleConversation),
    (channel) => activityOfChannel(activity, channel),
  );
  let next = 0;
  return channels.map((channel) => (isPeopleConversation(channel) ? ordered[next++]! : channel));
}
