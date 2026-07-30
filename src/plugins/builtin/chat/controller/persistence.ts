import type { PluginPersistence, PluginResumeState } from "../../../../types/plugin";
import type { PersistedAuthUser } from "../../../../api-client";
import {
  CHANNEL_SCHEMA_VERSION,
  MAX_CACHED_MESSAGES,
  SESSION_SCHEMA_VERSION,
  SESSION_STATE_KEY,
  TRANSCRIPT_CACHE_POLICY,
  TRANSCRIPT_KIND,
  TRANSCRIPT_SCHEMA_VERSION,
  TRANSCRIPT_SOURCE,
  channelStateKey,
  hydrateChannelRuntimeState,
  type ChannelRuntimeState,
  type PersistedChannelState,
  type PersistedSessionState,
  type PersistedTranscript,
} from "./state";

export interface ChatSessionUser {
  id: string;
  username: string;
  emailVerified: boolean;
  plan?: "free" | "pro";
}

export function readChatSessionState(
  persistence: PluginPersistence | null,
  resume: PluginResumeState | null,
): PersistedSessionState | null {
  return resume?.getState<PersistedSessionState>(SESSION_STATE_KEY, {
    schemaVersion: SESSION_SCHEMA_VERSION,
  }) ?? persistence?.getState<PersistedSessionState>(SESSION_STATE_KEY, {
    schemaVersion: SESSION_SCHEMA_VERSION,
  }) ?? null;
}

export function normalizeSessionUser(user: PersistedAuthUser | null | undefined): ChatSessionUser | null {
  return user
    ? {
      id: user.id,
      username: user.username ?? user.name ?? "account",
      emailVerified: user.emailVerified === true,
      plan: user.plan,
    }
    : null;
}

export function hydratePersistedChannelState({
  channelId,
  channel,
  persistence,
  resume,
  userId,
  sessionToken,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  persistence: PluginPersistence | null;
  resume: PluginResumeState | null;
  userId: string | null;
  sessionToken: string | null;
}): void {
  if (channel.hydrated || !persistence) return;
  channel.hydrated = true;

  const persistedChannel = resume?.getState<PersistedChannelState>(channelStateKey(channelId), {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
  }) ?? persistence.getState<PersistedChannelState>(channelStateKey(channelId), {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
  });
  const transcript = persistence.getResource<PersistedTranscript>(TRANSCRIPT_KIND, channelId, {
    sourceKey: TRANSCRIPT_SOURCE,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    allowExpired: true,
  });
  hydrateChannelRuntimeState({
    channel,
    messages: transcript?.value.messages ?? [],
    persistedChannel,
    userId,
    sessionToken,
  });
}

export function persistChatSession({
  persistence,
  resume,
  sessionToken,
  user,
}: {
  persistence: PluginPersistence | null;
  resume: PluginResumeState | null;
  sessionToken: string | null;
  user: ChatSessionUser | null;
}): void {
  const value = {
    sessionToken,
    user,
  } satisfies PersistedSessionState;
  resume?.setState(SESSION_STATE_KEY, value, {
    schemaVersion: SESSION_SCHEMA_VERSION,
  });
  persistence?.setState(SESSION_STATE_KEY, value, {
    schemaVersion: SESSION_SCHEMA_VERSION,
  });
}

export function deleteChatSession(persistence: PluginPersistence | null): void {
  persistence?.deleteState(SESSION_STATE_KEY);
}

export function writeChatChannelState({
  channelId,
  channel,
  persistence,
  resume,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  persistence: PluginPersistence | null;
  resume: PluginResumeState | null;
}): void {
  const value = {
    draft: channel.draft,
    draftClientMessageId: channel.draftClientMessageId,
    replyToId: channel.replyToId,
    lastCursor: channel.lastCursor,
    lastViewedMessageId: channel.lastViewedMessageId,
  } satisfies PersistedChannelState;
  resume?.setState(channelStateKey(channelId), value, {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
  });
  persistence?.setState(channelStateKey(channelId), value, {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
  });
}

export function deleteChatTranscript(persistence: PluginPersistence | null, channelId: string): void {
  persistence?.deleteResource(TRANSCRIPT_KIND, channelId, { sourceKey: TRANSCRIPT_SOURCE });
}

export function persistChatTranscript({
  channelId,
  channel,
  persistence,
  resume,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  persistence: PluginPersistence | null;
  resume: PluginResumeState | null;
}): void {
  if (channel.messages.length === 0) {
    deleteChatTranscript(persistence, channelId);
    writeChatChannelState({ channelId, channel, persistence, resume });
    return;
  }

  persistence?.setResource(TRANSCRIPT_KIND, channelId, {
    messages: channel.messages.slice(-MAX_CACHED_MESSAGES),
  } satisfies PersistedTranscript, {
    sourceKey: TRANSCRIPT_SOURCE,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    cachePolicy: TRANSCRIPT_CACHE_POLICY,
  });
  writeChatChannelState({ channelId, channel, persistence, resume });
}
