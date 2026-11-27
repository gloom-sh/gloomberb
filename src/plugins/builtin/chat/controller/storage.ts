import type { PluginPersistence, PluginResumeState } from "../../../../types/plugin";
import {
  clearDraftSyncTimer,
  flushDraftSync,
  scheduleDraftSync,
} from "./draft-sync";
import {
  deleteChatSession,
  deleteChatTranscript,
  hydratePersistedChannelState,
  persistChatSession,
  persistChatTranscript,
  readChatComposerState,
  readChatSessionState,
  writeChatChannelState,
  writeChatComposerState,
  type ChatSessionUser,
} from "./persistence";
import {
  createEmptyChannelState,
  hydrateComposerState,
  normalizeChannelId,
  type ChannelRuntimeState,
} from "./state";
import { clearComposerState } from "./lifecycle";

interface ChatControllerStorageOptions {
  emit: (channelId?: string) => void;
  getUser: () => ChatSessionUser | null;
}

export class ChatControllerStorage {
  private persistence: PluginPersistence | null = null;
  private resume: PluginResumeState | null = null;
  private composerAccount: { id: string } | null = null;
  readonly channelStates = new Map<string, ChannelRuntimeState>();

  constructor(private readonly options: ChatControllerStorageOptions) {}

  attachPersistence(persistence: PluginPersistence, resume?: PluginResumeState): void {
    this.persistence = persistence;
    this.resume = resume ?? this.resume;
  }

  getComposerAccount(): { id: string } | null {
    return this.composerAccount;
  }

  setComposerAccount(accountId: string | null): void {
    if ((this.composerAccount?.id ?? null) === accountId) return;
    for (const [channelId, channel] of this.channelStates) {
      this.flushDraftSync(channelId);
      clearComposerState(channel);
    }
    this.composerAccount = accountId ? { id: accountId } : null;
    for (const [channelId, channel] of this.channelStates) this.hydrateComposer(channelId, channel);
  }

  hasPersistence(): boolean {
    return !!this.persistence;
  }

  readSessionState(): ReturnType<typeof readChatSessionState> {
    return readChatSessionState(this.persistence, this.resume);
  }

  ensureChannelState(channelId: string): ChannelRuntimeState {
    const normalizedChannelId = normalizeChannelId(channelId);
    const existing = this.channelStates.get(normalizedChannelId);
    if (existing) return existing;

    const channel = createEmptyChannelState();
    this.channelStates.set(normalizedChannelId, channel);
    this.hydrateChannelState(normalizedChannelId, channel);
    this.hydrateComposer(normalizedChannelId, channel);
    return channel;
  }

  persistSession(sessionToken: string | null, user: ChatSessionUser | null): void {
    persistChatSession({
      persistence: this.persistence,
      resume: this.resume,
      sessionToken,
      user,
    });
  }

  deleteSession(): void {
    deleteChatSession(this.persistence);
  }

  deleteTranscript(channelId: string): void {
    deleteChatTranscript(this.persistence, channelId);
  }

  persistChannelState(channelId: string): void {
    this.writeChannelState(channelId);
  }

  persistComposer(channelId: string): void {
    const account = this.composerAccount;
    if (!account) return;
    const channel = this.ensureChannelState(channelId);
    this.clearDraftSyncTimer(channel);
    writeChatComposerState(this.persistence, this.resume, account.id, channelId, channel);
  }

  scheduleDraftSync(channelId: string): void {
    const account = this.composerAccount;
    if (!account) return;
    const channel = this.ensureChannelState(channelId);
    scheduleDraftSync({
      channelId,
      channel,
      writeChannelState: (nextChannelId) => {
        if (this.composerAccount === account) this.persistComposer(nextChannelId);
      },
      emit: (nextChannelId) => this.options.emit(nextChannelId),
    });
  }

  clearDraftSyncTimer(channel: ChannelRuntimeState): void {
    clearDraftSyncTimer(channel);
  }

  flushDraftSync(channelId: string): void {
    const channel = this.ensureChannelState(channelId);
    flushDraftSync({
      channelId,
      channel,
      writeChannelState: (nextChannelId) => this.persistComposer(nextChannelId),
    });
  }

  persistTranscript(channelId: string): void {
    const channel = this.ensureChannelState(channelId);
    persistChatTranscript({
      channelId,
      channel,
      persistence: this.persistence,
      resume: this.resume,
    });
  }

  private hydrateChannelState(channelId: string, channel: ChannelRuntimeState): void {
    hydratePersistedChannelState({
      channelId,
      channel,
      persistence: this.persistence,
      resume: this.resume,
      userId: this.options.getUser()?.id ?? null,
    });
  }

  private hydrateComposer(channelId: string, channel: ChannelRuntimeState): void {
    const account = this.composerAccount;
    if (!account) return;
    hydrateComposerState(channel, readChatComposerState(this.persistence, this.resume, account.id, channelId));
  }

  private writeChannelState(channelId: string): void {
    const channel = this.ensureChannelState(channelId);
    writeChatChannelState({
      channelId,
      channel,
      persistence: this.persistence,
      resume: this.resume,
    });
  }
}
