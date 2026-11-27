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
  composerStateKey,
  hydrateChannelRuntimeState,
  type ChannelRuntimeState,
  type PersistedChannelState,
  type PersistedComposerState,
  type PersistedSessionState,
  type PersistedTranscript,
} from "./state";

export interface ChatSessionUser {
  id: string;
  username: string;
  emailVerified: boolean;
  plan?: "free" | "pro";
  /** Cached so a cold start renders the right entitlement before /auth/get-session lands. */
  trialEndsAt?: string | null;
  effectivePlan?: "free" | "pro";
}

function readDualState<T>(
  persistence: PluginPersistence | null,
  resume: PluginResumeState | null,
  key: string,
  schemaVersion: number,
): T | null {
  return resume?.getState<T>(key, { schemaVersion })
    ?? persistence?.getState<T>(key, { schemaVersion })
    ?? null;
}

function writeDualState<T>(
  persistence: PluginPersistence | null,
  resume: PluginResumeState | null,
  key: string,
  value: T,
  schemaVersion: number,
): void {
  resume?.setState(key, value, { schemaVersion });
  persistence?.setState(key, value, { schemaVersion });
}

export function readChatSessionState(
  persistence: PluginPersistence | null,
  resume: PluginResumeState | null,
): PersistedSessionState | null {
  return readDualState<PersistedSessionState>(persistence, resume, SESSION_STATE_KEY, SESSION_SCHEMA_VERSION);
}

export function normalizeSessionUser(user: PersistedAuthUser | null | undefined): ChatSessionUser | null {
  return user
    ? {
      id: user.id,
      username: user.username ?? user.name ?? "account",
      emailVerified: user.emailVerified === true,
      plan: user.plan,
      trialEndsAt: user.trialEndsAt ?? undefined,
      effectivePlan: user.effectivePlan,
    }
    : null;
}

export function hydratePersistedChannelState({
  channelId,
  channel,
  persistence,
  resume,
  userId,
}: {
  channelId: string;
  channel: ChannelRuntimeState;
  persistence: PluginPersistence | null;
  resume: PluginResumeState | null;
  userId: string | null;
}): void {
  if (channel.hydrated || !persistence) return;
  channel.hydrated = true;

  const persistedChannel = readDualState<PersistedChannelState>(
    persistence,
    resume,
    channelStateKey(channelId),
    CHANNEL_SCHEMA_VERSION,
  );
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
  writeDualState<PersistedSessionState>(
    persistence,
    resume,
    SESSION_STATE_KEY,
    { sessionToken, user },
    SESSION_SCHEMA_VERSION,
  );
}

export function deleteChatSession(persistence: PluginPersistence | null, resume: PluginResumeState | null): void {
  persistence?.deleteState(SESSION_STATE_KEY);
  resume?.deleteState(SESSION_STATE_KEY);
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
  writeDualState<PersistedChannelState>(
    persistence,
    resume,
    channelStateKey(channelId),
    { lastCursor: channel.lastCursor, lastViewedMessageId: channel.lastViewedMessageId },
    CHANNEL_SCHEMA_VERSION,
  );
}

export function readChatComposerState(
  persistence: PluginPersistence | null,
  resume: PluginResumeState | null,
  accountId: string,
  channelId: string,
): PersistedComposerState | null {
  return readDualState<PersistedComposerState>(persistence, resume, composerStateKey(accountId, channelId), 1);
}

export function writeChatComposerState(
  persistence: PluginPersistence | null,
  resume: PluginResumeState | null,
  accountId: string,
  channelId: string,
  channel: ChannelRuntimeState,
): void {
  writeDualState<PersistedComposerState>(
    persistence,
    resume,
    composerStateKey(accountId, channelId),
    { draft: channel.draft, draftClientMessageId: channel.draftClientMessageId, replyToId: channel.replyToId },
    1,
  );
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
