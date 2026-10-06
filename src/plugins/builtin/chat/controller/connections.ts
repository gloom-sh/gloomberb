import { DEFAULT_CHAT_CHANNEL_ID, type ChannelRuntimeState } from "./state";
import type { ChatMessage } from "../../../../api-client";
import { isSameMessageRevision } from "./messages";

export function countOpenConnections(channelStates: Iterable<ChannelRuntimeState>): number {
  return [...channelStates].filter((channel) => !!channel.wsConnection).length;
}

export function closeAllChannelConnections(channelStates: Iterable<ChannelRuntimeState>): void {
  for (const channel of channelStates) {
    channel.wsConnection?.close();
    channel.wsConnection = null;
    channel.wsConnected = false;
  }
}

export function getSafetyRefreshChannelIds(channelStates: Iterable<[string, ChannelRuntimeState]>): string[] {
  const active = [...channelStates]
    .filter(([, channel]) => channel.openViewCount > 0 || channel.notificationsEnabled || channel.wsConnection)
    .map(([channelId]) => channelId);
  return active.length > 0 ? active : [DEFAULT_CHAT_CHANNEL_ID];
}

export function getOpenConnectionChannelIds(channelStates: Iterable<[string, ChannelRuntimeState]>): Set<string> {
  const channelIds = new Set<string>([DEFAULT_CHAT_CHANNEL_ID]);
  for (const [channelId, channel] of channelStates) {
    if (channel.openViewCount > 0 || channel.notificationsEnabled) {
      channelIds.add(channelId);
    }
  }
  return channelIds;
}

export function closeInactiveChannelConnections(
  channelStates: Iterable<[string, ChannelRuntimeState]>,
  activeChannelIds: Set<string>,
): void {
  for (const [channelId, channel] of channelStates) {
    if (activeChannelIds.has(channelId) || !channel.wsConnection || channel.openViewCount > 0) continue;
    channel.wsConnection.close();
    channel.wsConnection = null;
    channel.wsConnected = false;
  }
}

interface EnsureChatChannelConnectionOptions {
  channelId: string;
  channel: ChannelRuntimeState;
  canConnect: boolean;
  stopSafetyRefresh: () => void;
  startSafetyRefresh: () => void;
  refreshMessages: () => Promise<void>;
  connectChannel: (
    channelId: string,
    onMessage: (message: ChatMessage) => void,
    onDisconnect: () => void,
  ) => NonNullable<ChannelRuntimeState["wsConnection"]>;
  mergeMessages: (messages: ChatMessage[]) => void;
}

export function ensureChatChannelConnection({
  channelId,
  channel,
  canConnect,
  stopSafetyRefresh,
  startSafetyRefresh,
  refreshMessages,
  connectChannel,
  mergeMessages,
}: EnsureChatChannelConnectionOptions): void {
  if (!canConnect) {
    stopSafetyRefresh();
    return;
  }
  startSafetyRefresh();
  if (channel.wsConnected) return;
  channel.wsConnected = true;

  void refreshMessages().catch(() => {});

  channel.wsConnection = connectChannel(
    channelId,
    (message) => {
      const known = channel.messages.find((entry) => entry.id === message.id);
      if (known && isSameMessageRevision(known, message)) return;
      mergeMessages([message]);
    },
    () => {
      channel.wsConnected = false;
    },
  );
}
