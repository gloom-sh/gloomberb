import type { TapeFeedEvent } from "./tape";
import type {
  ChatChannelState,
  ChatMessage,
  ChatNotification,
  ChatReactionsUpdate,
  ScannerFeedEvent,
  ScannerKind,
  TeamNotification,
} from "./types";
import { marketKey } from "./socket-quotes";

type Listener<Args extends unknown[]> = (...args: Args) => void;

/**
 * What taking a listener off its key did: the key had no listeners, this one was not among them, it went and others
 * remain, or it was the key's last and the key went with it.
 */
type ListenerRemoval = "unknown-key" | "not-listening" | "removed" | "last";

/** Listeners to one kind of event, called in the order they subscribed. */
export class ListenerSet<Args extends unknown[] = []> {
  private readonly listeners = new Set<Listener<Args>>();

  get size(): number {
    return this.listeners.size;
  }

  /** Adds a listener; the returned function removes it. */
  add(listener: Listener<Args>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: Args): void {
    for (const listener of this.listeners) listener(...args);
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Listeners grouped under a key (a chat channel, a frame type, a scanner); a key goes with its last listener. */
class KeyedListeners<K, Args extends unknown[]> {
  private readonly groups = new Map<K, Set<Listener<Args>>>();

  /** How many keys have listeners. */
  get size(): number {
    return this.groups.size;
  }

  keys(): IterableIterator<K> {
    return this.groups.keys();
  }

  /** Adds a listener under its key; true when it is the key's first. */
  add(key: K, listener: Listener<Args>): boolean {
    const group = this.groups.get(key) ?? new Set<Listener<Args>>();
    const first = group.size === 0;
    group.add(listener);
    this.groups.set(key, group);
    return first;
  }

  remove(key: K, listener: Listener<Args>): ListenerRemoval {
    const group = this.groups.get(key);
    if (!group) return "unknown-key";
    if (!group.delete(listener)) return "not-listening";
    if (group.size > 0) return "removed";
    this.groups.delete(key);
    return "last";
  }

  emit(key: K, ...args: Args): void {
    for (const listener of this.groups.get(key) ?? []) listener(...args);
  }

  clear(): void {
    this.groups.clear();
  }
}

/** A tape's market, as its subscribe frame names it. */
type TapeMarket = { symbol: string; exchange: string };

/** Tape listeners by market; each market keeps the symbol and exchange it was first subscribed with. */
class TapeListeners {
  private readonly byMarket = new Map<string, TapeMarket & { listeners: Set<Listener<[TapeFeedEvent]>> }>();

  /** How many markets have listeners. */
  get size(): number {
    return this.byMarket.size;
  }

  markets(): Iterable<TapeMarket> {
    return this.byMarket.values();
  }

  /** Adds a listener to a normalized market; true when it is the market's first. */
  add(market: TapeMarket, listener: Listener<[TapeFeedEvent]>): boolean {
    const key = marketKey(market.symbol, market.exchange);
    const existing = this.byMarket.get(key);
    const entry = existing ?? { ...market, listeners: new Set<Listener<[TapeFeedEvent]>>() };
    entry.listeners.add(listener);
    this.byMarket.set(key, entry);
    return !existing;
  }

  remove(market: TapeMarket, listener: Listener<[TapeFeedEvent]>): ListenerRemoval {
    const key = marketKey(market.symbol, market.exchange);
    const entry = this.byMarket.get(key);
    if (!entry) return "unknown-key";
    if (!entry.listeners.delete(listener)) return "not-listening";
    if (entry.listeners.size) return "removed";
    this.byMarket.delete(key);
    return "last";
  }

  /** One market's event, keyed as the frame names it. */
  emit(symbol: string, exchange: string, event: TapeFeedEvent): void {
    for (const listener of this.byMarket.get(marketKey(symbol, exchange))?.listeners ?? []) listener(event);
  }

  /** A stream status every tape shares: a reset or a disconnect. */
  emitAll(event: Exclude<TapeFeedEvent, { type: "data" }>): void {
    for (const entry of this.byMarket.values()) for (const listener of entry.listeners) listener(event);
  }

  clear(): void {
    this.byMarket.clear();
  }
}

/** Scanner listeners by kind, with the latest payload of each so a pane opened mid-stream does not wait for the next tick. */
class ScannerListeners {
  private readonly listeners = new KeyedListeners<ScannerKind, [ScannerFeedEvent]>();
  private readonly snapshots = new Map<ScannerKind, ScannerFeedEvent>();

  /** How many scanners have listeners. */
  get size(): number {
    return this.listeners.size;
  }

  keys(): IterableIterator<ScannerKind> {
    return this.listeners.keys();
  }

  /** Adds a listener to a scanner; true when it is the scanner's first. */
  add(scanner: ScannerKind, listener: Listener<[ScannerFeedEvent]>): boolean {
    return this.listeners.add(scanner, listener);
  }

  snapshot(scanner: ScannerKind): ScannerFeedEvent | undefined {
    return this.snapshots.get(scanner);
  }

  /** Removes a listener; the scanner's payload goes with its last one. */
  remove(scanner: ScannerKind, listener: Listener<[ScannerFeedEvent]>): ListenerRemoval {
    const removal = this.listeners.remove(scanner, listener);
    if (removal === "last") this.snapshots.delete(scanner);
    return removal;
  }

  emit(scanner: ScannerKind, event: ScannerFeedEvent): void {
    this.snapshots.set(scanner, event);
    this.listeners.emit(scanner, event);
  }

  clear(): void {
    this.listeners.clear();
    this.snapshots.clear();
  }
}

/** Everyone the socket hands server frames to, by what they listen for. */
export class SocketListeners {
  readonly chatChannels = new KeyedListeners<string, [ChatMessage]>();
  readonly chatNotifications = new ListenerSet<[ChatNotification]>();
  readonly chatMentionCandidates = new ListenerSet();
  readonly chatChannelState = new ListenerSet<[ChatChannelState]>();
  readonly chatReactions = new ListenerSet<[ChatReactionsUpdate]>();
  readonly chatPresence = new ListenerSet<[number]>();
  readonly teamNotifications = new ListenerSet<[TeamNotification]>();
  /** Server push frames by type, e.g. a team layout update. */
  readonly cloudEvents = new KeyedListeners<string, [unknown]>();
  /** "ready" after each server hello, "closed" when that connection ends. */
  readonly connection = new ListenerSet<["ready" | "closed"]>();
  readonly tape = new TapeListeners();
  readonly scanners = new ScannerListeners();

  /** Drops the listeners a disposed socket no longer serves. Mention-candidate listeners stay subscribed across a dispose. */
  clear(): void {
    this.chatChannels.clear();
    this.connection.clear();
    this.chatNotifications.clear();
    this.chatChannelState.clear();
    this.chatPresence.clear();
    this.chatReactions.clear();
    this.teamNotifications.clear();
    this.cloudEvents.clear();
    this.tape.clear();
    this.scanners.clear();
  }
}
