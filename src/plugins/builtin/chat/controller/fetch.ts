import {
  apiClient,
  type ChatMessage,
} from "../../../../api-client";
import {
  MESSAGE_PAGE_SIZE,
  type ChannelRuntimeState,
  type MergeMessagesOptions,
} from "./state";

interface ChatFetchDeps {
  mergeMessages(channelId: string, messages: ChatMessage[], options?: MergeMessagesOptions): void;
  persistChannelState(channelId: string): void;
  /** Who is reading, as the request goes out: the signed-in account's id, or null. */
  readerId?(): string | null;
}

export async function fetchLatestChannelMessages(
  channelId: string,
  channel: ChannelRuntimeState,
  deps: ChatFetchDeps,
): Promise<void> {
  const hasIncrementalCursor = !!channel.lastCursor;
  const hadMessages = channel.messages.length > 0;
  const countIncrementalUnread = hadMessages && hasIncrementalCursor;
  // The first fetch of a session drops the cursor so anything missed while the
  // socket was connected comes back. Merging is keyed by message id, so
  // re-reading known messages changes nothing and counts no unread. A new
  // reader backfills too: the page carries each reader's own reactions.
  const readerId = deps.readerId?.() ?? null;
  const backfillGaps = !channel.backfilled || channel.backfilledAs !== readerId;

  try {
    const messages = await apiClient.getMessages(channelId, {
      limit: MESSAGE_PAGE_SIZE,
      after: backfillGaps ? undefined : channel.lastCursor ?? undefined,
    });
    // A full page asked for while this read was out still happens next time.
    if (backfillGaps) {
      channel.backfilled = true;
      channel.backfilledAs = readerId;
    }
    if ((!hasIncrementalCursor || backfillGaps) && messages.length < MESSAGE_PAGE_SIZE) {
      channel.reachedOldestMessage = true;
    }
    if (messages.length > 0) {
      deps.mergeMessages(channelId, messages, { countUnread: countIncrementalUnread });
      return;
    }
    deps.persistChannelState(channelId);
    return;
  } catch {
    const messages = await apiClient.getMessages(channelId, { limit: MESSAGE_PAGE_SIZE });
    channel.backfilled = true;
    channel.backfilledAs = readerId;
    if (messages.length < MESSAGE_PAGE_SIZE) {
      channel.reachedOldestMessage = true;
    }
    if (messages.length > 0) {
      deps.mergeMessages(channelId, messages, { countUnread: false });
      return;
    }
    deps.persistChannelState(channelId);
  }
}

export async function fetchOlderChannelMessages(
  channelId: string,
  before: string,
  channel: ChannelRuntimeState,
  deps: ChatFetchDeps,
): Promise<void> {
  const messages = await apiClient.getMessages(channelId, {
    limit: MESSAGE_PAGE_SIZE,
    before,
  });
  if (messages.length < MESSAGE_PAGE_SIZE) {
    channel.reachedOldestMessage = true;
  }
  if (messages.length === 0) {
    deps.persistChannelState(channelId);
    return;
  }
  deps.mergeMessages(channelId, messages, { countUnread: false });
}
