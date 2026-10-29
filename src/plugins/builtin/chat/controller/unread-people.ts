import { apiClient, type ChatChannel, type ChatMessage } from "../../../../api-client";
import type { ChannelRuntimeState, ChannelUnreadPeople, UnreadMessageForYou } from "./state";
import { chatMessageMentionsUsername, normalizeChatUsername } from "./utils";

/** The most messages the server returns for one request. */
const PAGE_SIZE = 100;
/**
 * A channel reads at most this many pages of its unread messages, the newest
 * ones: 300. A mention older than that in a channel with more than 300 unread
 * is not counted, which keeps a busy channel left unread for weeks from
 * costing hundreds of requests at every launch.
 */
const MAX_PAGES = 3;
const RETRY_AFTER_FAILURE_MS = 60_000;

interface Reader {
  id: string;
  username: string | null;
}

/** What the app badge and the status bar need of one unread message. */
interface UnreadFact extends Omit<UnreadMessageForYou, "messageId"> {
  messageId: string;
  /** It mentions you, or replies to a message of yours. */
  mentionsYou: boolean;
}

function sentAt(createdAt: string | null | undefined): number {
  const time = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/** Whether the message answers one of `reader`'s, by account or, from a server that leaves the id out, by username. */
function repliesTo(message: ChatMessage, reader: Reader): boolean {
  const author = message.replyTo?.user;
  if (!author) return false;
  if (author.id) return author.id === reader.id;
  return !!reader.username && normalizeChatUsername(author.username) === reader.username;
}

function unreadFact(message: ChatMessage, reader: Reader): UnreadFact {
  return {
    messageId: message.id,
    senderId: message.user.id,
    senderName: message.user.username?.trim() || message.user.displayName,
    at: sentAt(message.createdAt),
    mentionsYou: (!!reader.username && chatMessageMentionsUsername(message.content, reader.username))
      || repliesTo(message, reader),
  };
}

/**
 * The people behind unread messages, and the newest one for you. In a DM or
 * group chat (`everyMessageForYou`) every message is for you; elsewhere only
 * the ones that mention or reply to you are.
 */
function peopleOf(facts: Iterable<UnreadFact>, everyMessageForYou: boolean): ChannelUnreadPeople {
  const senders = new Set<string>();
  const mentioners = new Set<string>();
  let latestForYou: UnreadMessageForYou | null = null;
  let forYouCount = 0;
  for (const fact of facts) {
    senders.add(fact.senderId);
    if (fact.mentionsYou) mentioners.add(fact.senderId);
    if (!everyMessageForYou && !fact.mentionsYou) continue;
    forYouCount += 1;
    if (!latestForYou || fact.at >= latestForYou.at) {
      latestForYou = { messageId: fact.messageId, senderId: fact.senderId, senderName: fact.senderName, at: fact.at };
    }
  }
  return { senders: [...senders], mentioners: [...mentioners], latestForYou, forYouCount };
}

/**
 * The people behind unread messages: who sent them, who mentioned or replied
 * to `reader`, and the newest message for them. Your own messages are never
 * unread.
 */
export function summarizeUnreadMessages(
  messages: readonly ChatMessage[],
  reader: { id: string; username: string | null },
  { everyMessageForYou = false }: { everyMessageForYou?: boolean } = {},
): ChannelUnreadPeople {
  return peopleOf(
    messages.filter((message) => message.user.id !== reader.id).map((message) => unreadFact(message, reader)),
    everyMessageForYou,
  );
}

/** Messages read from the server for a channel whose unread messages are not all on this device. */
interface LoadedUnread {
  userId: string;
  username: string | null;
  /** The read marker they follow; a new marker makes them stale. */
  markerId: string;
  facts: Map<string, UnreadFact>;
  /** The newest message read, where the next load picks up. */
  newestId: string | null;
  /** The unread count the load was asked for, so a count that never matches is not asked for again. */
  loadedFor: number;
  failedAt: number | null;
}

interface UnreadPeopleOptions {
  getChannels: () => ChatChannel[];
  getChannelStates: () => Iterable<[string, ChannelRuntimeState]>;
  getUser: () => { id: string; username: string; emailVerified: boolean } | null;
  /** A load finished: the people changed. */
  onChange: () => void;
}

/**
 * Who each channel's unread messages are from, for the app badge and the
 * status bar. The server keeps a count per channel and a read marker, not
 * the senders, so they come from the messages after the marker: the ones
 * this device holds, and for a channel whose unread messages are not all
 * here, the newest 300 of the rest read from the server once (then only what
 * is new). Nothing is guessed: a channel that has not loaded yet reports the
 * unread messages it does hold.
 *
 * It does nothing, and makes no request, until something asks to
 * {@link track} it: the app badge, and the status bar while signed in.
 */
export class ChatControllerUnreadPeople {
  private readonly loaded = new Map<string, LoadedUnread>();
  private readonly inFlight = new Set<string>();
  private generation = 0;
  private trackers = 0;

  constructor(private readonly options: UnreadPeopleOptions) {}

  /** Starts keeping the people current for as long as the returned stop has not been called. */
  track(): () => void {
    this.trackers += 1;
    if (this.trackers === 1) this.options.onChange();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.trackers -= 1;
      if (this.trackers === 0) this.clear();
    };
  }

  snapshot(): Record<string, ChannelUnreadPeople> {
    const reader = this.trackers > 0 ? this.reader() : null;
    if (!reader) return {};
    const channels = new Map(this.options.getChannels().map((channel) => [channel.id, channel]));
    const people: Record<string, ChannelUnreadPeople> = {};
    for (const [channelId, state] of this.options.getChannelStates()) {
      if (state.unreadCount <= 0) continue;
      const channel = channels.get(channelId);
      const conversation = channel?.kind === "direct" || channel?.kind === "group";
      const known = peopleOf(this.knownFacts(channelId, state, reader).values(), conversation);
      // In a DM or group every unread message is for you, held here or not.
      if (conversation) known.forYouCount = state.unreadCount;
      const otherPerson = directPerson(channel);
      // Everything unread in a DM is from the one person on the other side.
      people[channelId] = otherPerson
        ? {
          senders: [otherPerson.id],
          mentioners: [],
          latestForYou: known.latestForYou ?? newestFrom(otherPerson, state, channel),
          forYouCount: known.forYouCount,
        }
        : known;
    }
    return people;
  }

  /** Starts reading what is missing for channels whose unread messages are not all here. Cheap when nothing is. */
  sync(): void {
    const reader = this.trackers > 0 ? this.reader() : null;
    if (!reader || !this.options.getUser()?.emailVerified) return;
    const channels = new Map(this.options.getChannels().map((channel) => [channel.id, channel]));
    for (const [channelId, state] of this.options.getChannelStates()) {
      const marker = state.lastViewedMessageId;
      const channel = channels.get(channelId);
      if (state.unreadCount <= 0 || !marker || !channel || directPerson(channel) || this.inFlight.has(channelId)) continue;
      if (this.knownFacts(channelId, state, reader).size >= state.unreadCount) continue;
      const loaded = this.currentLoad(channelId, marker, reader);
      if (loaded && loaded.loadedFor >= state.unreadCount) continue;
      if (loaded?.failedAt && Date.now() - loaded.failedAt < RETRY_AFTER_FAILURE_MS) continue;
      void this.load(channelId, marker, reader, state.unreadCount);
    }
  }

  /** Drops what was read and lets late answers fall away, as on sign-out. */
  clear(): void {
    this.generation += 1;
    this.loaded.clear();
    this.inFlight.clear();
  }

  private reader(): Reader | null {
    const user = this.options.getUser();
    return user ? { id: user.id, username: normalizeChatUsername(user.username) } : null;
  }

  private currentLoad(channelId: string, marker: string, reader: Reader): LoadedUnread | null {
    const loaded = this.loaded.get(channelId);
    return loaded && loaded.markerId === marker && loaded.userId === reader.id && loaded.username === reader.username
      ? loaded
      : null;
  }

  /**
   * The unread messages known for certain: those read from the server after
   * the read marker, and the cached ones after it. Without the marker nothing
   * can be placed before or after it, so none is claimed (the server counts
   * no unread without one either).
   */
  private knownFacts(channelId: string, state: ChannelRuntimeState, reader: Reader): Map<string, UnreadFact> {
    const facts = new Map<string, UnreadFact>();
    const marker = state.lastViewedMessageId;
    if (!marker) return facts;
    for (const [id, fact] of this.currentLoad(channelId, marker, reader)?.facts ?? []) facts.set(id, fact);
    const markerIndex = state.messages.findIndex((message) => message.id === marker);
    if (markerIndex < 0) return facts;
    for (const message of state.messages.slice(markerIndex + 1)) {
      if (message.user.id === reader.id || message.clientStatus) continue;
      facts.set(message.id, unreadFact(message, reader));
    }
    return facts;
  }

  private async load(channelId: string, marker: string, reader: Reader, wanted: number): Promise<void> {
    const generation = this.generation;
    this.inFlight.add(channelId);
    const previous = this.currentLoad(channelId, marker, reader);
    try {
      const messages = await readAfter(channelId, previous?.newestId ?? marker);
      if (generation !== this.generation) return;
      const facts = new Map(previous?.facts);
      for (const message of messages) {
        if (message.user.id !== reader.id) facts.set(message.id, unreadFact(message, reader));
      }
      this.loaded.set(channelId, {
        userId: reader.id,
        username: reader.username,
        markerId: marker,
        facts,
        newestId: messages.at(-1)?.id ?? previous?.newestId ?? null,
        loadedFor: wanted,
        failedAt: null,
      });
    } catch {
      if (generation !== this.generation) return;
      this.loaded.set(channelId, {
        userId: reader.id,
        username: reader.username,
        markerId: marker,
        facts: previous?.facts ?? new Map(),
        newestId: previous?.newestId ?? null,
        loadedFor: previous?.loadedFor ?? 0,
        failedAt: Date.now(),
      });
    } finally {
      if (generation === this.generation) this.inFlight.delete(channelId);
    }
    this.options.onChange();
  }
}

/**
 * The newest unread message of a DM whose read marker is not on this device:
 * unread messages are the newest ones, so it is the newest message held from
 * the other person, or failing one, just them as of the conversation's last
 * message.
 */
function newestFrom(
  person: NonNullable<ChatChannel["dmUser"]>,
  state: ChannelRuntimeState,
  channel: ChatChannel | undefined,
): UnreadMessageForYou {
  const held = state.messages.findLast((message) => message.user.id === person.id && !message.clientStatus);
  return {
    messageId: held?.id ?? null,
    senderId: person.id,
    senderName: person.username?.trim() || person.displayName,
    at: Math.max(sentAt(held?.createdAt), sentAt(channel?.lastMessageAt)),
  };
}

/** The one other person in a direct message, when the channel says who. */
function directPerson(channel: ChatChannel | undefined): NonNullable<ChatChannel["dmUser"]> | null {
  return channel?.kind === "direct" ? channel.dmUser ?? null : null;
}

/**
 * Every message after `after`, oldest first. The server answers a request
 * with the newest ones, so a long run reads back from the newest page to the
 * one that reaches `after`.
 */
async function readAfter(channelId: string, after: string): Promise<ChatMessage[]> {
  const pages: ChatMessage[][] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const messages = await apiClient.getMessages(channelId, { after, before, limit: PAGE_SIZE });
    if (messages.length === 0) break;
    pages.unshift(messages);
    if (messages.length < PAGE_SIZE) break;
    before = messages[0]!.id;
  }
  return pages.flat();
}
