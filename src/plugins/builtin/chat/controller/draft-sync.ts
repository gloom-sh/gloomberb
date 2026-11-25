import { DRAFT_SYNC_DEBOUNCE_MS, DRAFT_SYNC_MAX_WAIT_MS, type ChannelRuntimeState } from "./state";

export function clearDraftSyncTimer(channel: ChannelRuntimeState): void {
  if (channel.draftSyncTimer) clearTimeout(channel.draftSyncTimer);
  if (channel.draftSyncMaxTimer) clearTimeout(channel.draftSyncMaxTimer);
  channel.draftSyncTimer = null;
  channel.draftSyncMaxTimer = null;
}

export function scheduleDraftSync({
  channelId,
  channel,
  writeChannelState,
  emit,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  writeChannelState: (channelId: string) => void;
  emit: (channelId: string) => void;
}): void {
  const write = () => {
    clearDraftSyncTimer(channel);
    writeChannelState(channelId);
    emit(channelId);
  };
  if (channel.draftSyncTimer) clearTimeout(channel.draftSyncTimer);
  channel.draftSyncTimer = setTimeout(write, DRAFT_SYNC_DEBOUNCE_MS);
  channel.draftSyncTimer.unref?.();
  if (!channel.draftSyncMaxTimer) {
    channel.draftSyncMaxTimer = setTimeout(write, DRAFT_SYNC_MAX_WAIT_MS);
    channel.draftSyncMaxTimer.unref?.();
  }
}

export function flushDraftSync({
  channelId,
  channel,
  writeChannelState,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  writeChannelState: (channelId: string) => void;
}): void {
  if (!channel.draftSyncTimer) return;
  clearDraftSyncTimer(channel);
  writeChannelState(channelId);
}
