import type { ChatMentionCandidate } from "../../../../api-client";

type Entry = {
  value: ChatMentionCandidate[] | undefined;
  stale: boolean;
  revision: number;
  request: Promise<void> | null;
};

/** Session-only, channel-scoped, single-flight reads. Typing never calls load. */
export class ChatMentionCandidates {
  private owner: string | null = null;
  private entries = new Map<string, Entry>();

  constructor(private readonly options: {
    userId: () => string | null;
    activeChannels: () => string[];
    fetch: (channelId: string) => Promise<ChatMentionCandidate[]>;
    emit: (channelId: string) => void;
  }) {}

  private syncOwner(): string | null {
    const owner = this.options.userId();
    if (owner !== this.owner) {
      this.clear();
      this.owner = owner;
    }
    return owner;
  }

  get(channelId: string): ChatMentionCandidate[] | undefined {
    return this.syncOwner() ? this.entries.get(channelId)?.value : undefined;
  }

  load(channelId: string): Promise<void> {
    const owner = this.syncOwner();
    if (!owner) return Promise.resolve();
    let entry = this.entries.get(channelId);
    if (!entry) {
      entry = { value: undefined, stale: true, revision: 0, request: null };
      this.entries.set(channelId, entry);
    }
    if (entry.request) return entry.request;
    if (!entry.stale) return Promise.resolve();
    const current = entry;
    const revision = current.revision;
    current.stale = false;
    const isCurrent = () => this.options.userId() === owner && this.entries.get(channelId) === current;
    const request = this.options.fetch(channelId)
      .then((value) => {
        if (!isCurrent() || current.revision !== revision) return;
        current.value = value;
        this.options.emit(channelId);
      })
      .catch(() => {
        // An older server or a failed cold read still has loaded authors.
        // After invalidation, keep the empty set rather than stale members.
      })
      .finally(() => {
        current.request = null;
        if (isCurrent() && current.stale && this.options.activeChannels().includes(channelId)) {
          void this.load(channelId);
        }
      });
    current.request = request;
    return request;
  }

  recordConversation(userIds: string[], at: string): void {
    this.syncOwner();
    const people = new Set(userIds);
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) return;
    for (const [id, entry] of this.entries) {
      if (!entry.value) continue;
      let changed = false;
      const next = entry.value.map((person) => {
        if (!people.has(person.id) || timestamp <= (Date.parse(person.conversationActivityAt ?? "") || 0)) return person;
        changed = true;
        return { ...person, conversationActivityAt: at };
      });
      if (changed) {
        entry.value = next;
        this.options.emit(id);
      }
    }
  }

  invalidate(): void {
    this.syncOwner();
    for (const [id, entry] of this.entries) {
      entry.value = [];
      entry.stale = true;
      entry.revision++;
      this.options.emit(id);
    }
    for (const id of this.options.activeChannels()) void this.load(id);
  }

  clear(): void {
    this.entries.clear();
    this.owner = null;
  }
}
