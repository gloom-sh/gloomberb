import type { CloudQuotePayload, QuoteStreamTarget } from "./types";
import { debugLog, previewList } from "../utils/debug-log";
import { canonicalExchange, normalizeSymbol } from "../utils/exchanges";
import { mergeQuoteSubscriptionTargets } from "../market-data/quote-subscription-target";
import { perpetualListing } from "../tickers/perpetual-listing";

/** How long subscription changes gather before they go out as one unsubscribe and one subscribe frame. */
export const QUOTE_SUBSCRIPTION_FLUSH_MS = 25;
/**
 * The most perpetual listings the app streams at once, across every pane: on screen and selected first. The server
 * takes up to 100 from one connection (fewer signed out); the rest keep their fetched readings.
 */
const PERP_STREAM_BUDGET = 60;
/** On screen and selected first, then by weight; equal ones keep the order they were asked in. */
const perpStreamRank = (target: QuoteStreamTarget) => (target.selected ? 2 : 0) + (target.visible ? 1 : 0);
const isPerpTarget = (target: QuoteStreamTarget) => !!perpetualListing(target.symbol, target.exchange);
const cloudApiLog = debugLog.createLogger("cloud-api");

export type QuoteListener = (target: QuoteStreamTarget, quote: CloudQuotePayload) => void;
type QuoteSubscription = {
  target: QuoteStreamTarget;
  listener: QuoteListener;
};

/** What the quote stream needs from the connection. */
export type QuoteStreamLink = {
  /** The connection while it is open, null otherwise. */
  openSocket: () => WebSocket | null;
  /** Sends a frame on the open connection; nothing happens when there is none. */
  send: (payload: Record<string, unknown>) => void;
};

/** One listener's place in the quote stream. */
export type QuoteStreamSubscription = {
  /** Queues what the subscription added or changed for the server. */
  announce: () => void;
  /** Takes the listener off its targets and queues what that changes. */
  release: () => void;
};

/** One instrument's key across panes and frames: `AAPL:NASDAQ`, or the bare symbol without an exchange. */
export function marketKey(symbol: string, exchange?: string): string {
  const normalizedSymbolValue = normalizeSymbol(symbol);
  const normalizedExchangeValue = canonicalExchange(exchange);
  return normalizedExchangeValue
    ? `${normalizedSymbolValue}:${normalizedExchangeValue}`
    : normalizedSymbolValue;
}

/** A target as market.subscribe sends it: an exchange always, and only the priority fields that are set. */
function serializeQuoteStreamTarget(target: QuoteStreamTarget): QuoteStreamTarget {
  return {
    symbol: target.symbol,
    exchange: target.exchange ?? "",
    ...(target.surface ? { surface: target.surface } : {}),
    ...(target.visible ? { visible: true } : {}),
    ...(target.selected ? { selected: true } : {}),
    ...(Number.isFinite(target.weight) ? { weight: target.weight } : {}),
  };
}

function sameQuoteStreamTarget(left: QuoteStreamTarget, right: QuoteStreamTarget): boolean {
  return JSON.stringify(serializeQuoteStreamTarget(left)) === JSON.stringify(serializeQuoteStreamTarget(right));
}

function mergeQuoteStreamSubscriptions(subscriptions: Iterable<QuoteSubscription>): QuoteStreamTarget | null {
  return mergeQuoteSubscriptionTargets([...subscriptions].map((subscription) => subscription.target));
}

/** The targets normalized, one per instrument (the last asked wins), without the ones that name no symbol. */
function uniqueQuoteStreamTargets(targets: QuoteStreamTarget[]): QuoteStreamTarget[] {
  return [
    ...new Map(
      targets
        .filter((target) => typeof target.symbol === "string" && target.symbol.trim().length > 0)
        .map((target) => {
          const normalized = {
            symbol: normalizeSymbol(target.symbol),
            exchange: canonicalExchange(target.exchange),
            surface: target.surface,
            visible: target.visible,
            selected: target.selected,
            weight: target.weight,
          } satisfies QuoteStreamTarget;
          return [marketKey(normalized.symbol, normalized.exchange), normalized] as const;
        }),
    ).values(),
  ];
}

/**
 * Every pane's quote listeners, merged per instrument, and what the server streams for them. Changes gather for
 * QUOTE_SUBSCRIPTION_FLUSH_MS and go out together; a new connection gets the full set. Perpetual listings go out only
 * on a connection whose server offers them, within PERP_STREAM_BUDGET.
 */
export class QuoteStreamSubscriptions {
  private nextSubscriptionId = 1;
  private readonly subscriptions = new Map<string, Map<number, QuoteSubscription>>();
  /** Each instrument's merged target: what the server was asked to stream. */
  private readonly targets = new Map<string, QuoteStreamTarget>();
  private readonly pendingSubscribes = new Map<string, QuoteStreamTarget>();
  private readonly pendingUnsubscribes = new Map<string, QuoteStreamTarget>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The connection whose server offered perpetual markets. Asked of every connection: a reconnect may reach an older
   * server, which would read `BTC` on HYPERLIQUID as a stock symbol.
   */
  private perpsConnection: WebSocket | null = null;
  /** The perpetual listings this connection streams, within PERP_STREAM_BUDGET. */
  private streamedPerps = new Map<string, QuoteStreamTarget>();

  constructor(private readonly link: QuoteStreamLink) {}

  /** How many instruments are subscribed. */
  get size(): number {
    return this.targets.size;
  }

  /**
   * Registers a listener on its targets. Nothing is queued for the server until `announce`, so the caller can open
   * the connection in between.
   */
  subscribe(targets: QuoteStreamTarget[], listener: QuoteListener): QuoteStreamSubscription {
    const subscriptionId = this.nextSubscriptionId++;
    const uniqueTargets = uniqueQuoteStreamTargets(targets);

    const newSubscriptions: QuoteStreamTarget[] = [];
    const updatedSubscriptions: QuoteStreamTarget[] = [];
    for (const target of uniqueTargets) {
      const key = marketKey(target.symbol, target.exchange);
      const subscriptions = this.subscriptions.get(key) ?? new Map<number, QuoteSubscription>();
      const previousTarget = this.targets.get(key);
      subscriptions.set(subscriptionId, { target, listener });
      this.subscriptions.set(key, subscriptions);
      const mergedTarget = mergeQuoteStreamSubscriptions(subscriptions.values()) ?? target;
      if (!previousTarget) {
        newSubscriptions.push(target);
      } else if (!sameQuoteStreamTarget(previousTarget, mergedTarget)) {
        updatedSubscriptions.push(mergedTarget);
      }
      this.targets.set(key, mergedTarget);
    }

    return {
      announce: () => {
        const subscriptionsToSend = [...newSubscriptions, ...updatedSubscriptions];
        if (subscriptionsToSend.length === 0) return;
        cloudApiLog.info("register quote listeners", {
          count: subscriptionsToSend.length,
          symbols: previewList(subscriptionsToSend, (target) => marketKey(target.symbol, target.exchange)),
        });
        this.queueSubscribes(subscriptionsToSend);
      },
      release: () => this.release(subscriptionId, uniqueTargets),
    };
  }

  /** Delivers one market.quote frame, or one item of a market.quotes batch, to its listeners. */
  deliver(frame: any): void {
    if (!frame?.quote || typeof frame.symbol !== "string") return;
    const subscriptions = this.subscriptions.get(marketKey(frame.symbol, frame.exchange));
    if (!subscriptions) return;
    const quote: CloudQuotePayload = {
      ...(frame.quote as CloudQuotePayload),
      ...(frame.delivery === "stream" || frame.delivery === "poll"
        ? { delivery: frame.delivery }
        : {}),
      ...(typeof frame.stale === "boolean" ? { stale: frame.stale } : {}),
    };
    for (const subscription of subscriptions.values()) {
      subscription.listener(subscription.target, quote);
    }
  }

  /** A connection opened: what was queued before is part of the full set it is about to get. */
  dropPending(): void {
    this.pendingSubscribes.clear();
    this.pendingUnsubscribes.clear();
  }

  /** Sends the full set on a connection that just opened; perpetual listings once its server offers them. */
  replay(): void {
    const targets = [...this.targets.values()].filter((target) => !isPerpTarget(target));
    if (targets.length > 0) {
      this.link.send({
        type: "market.subscribe",
        symbols: targets.map((target) => serializeQuoteStreamTarget(target)),
      });
    }
    this.streamedPerps.clear();
    this.syncPerpSubscriptions();
  }

  /**
   * The connection whose server offers perpetual markets, null when the last hello did not. Perpetual listings held
   * back since the socket opened go out once it is the open one.
   */
  setPerpsConnection(socket: WebSocket | null): void {
    if (socket === this.perpsConnection) return;
    this.perpsConnection = socket;
    this.streamedPerps.clear();
    this.syncPerpSubscriptions();
  }

  /** Drops every listener and queued change, and the flush waiting for them. */
  clear(): void {
    this.subscriptions.clear();
    this.targets.clear();
    this.pendingSubscribes.clear();
    this.pendingUnsubscribes.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private release(subscriptionId: number, uniqueTargets: QuoteStreamTarget[]): void {
    const removedTargets: QuoteStreamTarget[] = [];
    const updatedTargets: QuoteStreamTarget[] = [];

    for (const target of uniqueTargets) {
      const key = marketKey(target.symbol, target.exchange);
      const subscriptions = this.subscriptions.get(key);
      if (!subscriptions || !subscriptions.delete(subscriptionId)) continue;
      const previousTarget = this.targets.get(key);
      if (subscriptions.size === 0) {
        this.subscriptions.delete(key);
        if (previousTarget) removedTargets.push(previousTarget);
        this.targets.delete(key);
        continue;
      }
      const mergedTarget = mergeQuoteStreamSubscriptions(subscriptions.values());
      if (!mergedTarget) continue;
      this.targets.set(key, mergedTarget);
      if (previousTarget && !sameQuoteStreamTarget(previousTarget, mergedTarget)) {
        updatedTargets.push(mergedTarget);
      }
    }

    if (updatedTargets.length > 0) {
      this.queueSubscribes(updatedTargets);
    }

    if (removedTargets.length > 0) {
      cloudApiLog.info("remove quote listeners", {
        count: removedTargets.length,
        symbols: previewList(removedTargets, (target) => marketKey(target.symbol, target.exchange)),
      });
      this.queueUnsubscribes(removedTargets);
    }
  }

  /**
   * Streams the perpetual listings within the budget, once this connection's server offers them: the best ranked
   * across every pane. One that falls out is unsubscribed; one whose target changed (`changed`) is sent again.
   */
  private syncPerpSubscriptions(changed: ReadonlySet<string> = new Set()): void {
    const ws = this.link.openSocket();
    if (!ws || this.perpsConnection !== ws) return;
    const wanted = new Map(
      [...this.targets]
        .filter(([, target]) => isPerpTarget(target))
        .sort(([, left], [, right]) => perpStreamRank(right) - perpStreamRank(left) || (right.weight ?? 0) - (left.weight ?? 0))
        .slice(0, PERP_STREAM_BUDGET),
    );
    const unsubscribes = [...this.streamedPerps].filter(([key]) => !wanted.has(key)).map(([, target]) => target);
    const subscribes = [...wanted].filter(([key]) => !this.streamedPerps.has(key) || changed.has(key)).map(([, target]) => target);
    this.streamedPerps = wanted;
    if (unsubscribes.length > 0) {
      this.link.send({ type: "market.unsubscribe", symbols: unsubscribes.map((target) => serializeQuoteStreamTarget(target)) });
    }
    if (subscribes.length > 0) {
      this.link.send({ type: "market.subscribe", symbols: subscribes.map((target) => serializeQuoteStreamTarget(target)) });
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushQueued();
    }, QUOTE_SUBSCRIPTION_FLUSH_MS);
  }

  private queueSubscribes(targets: QuoteStreamTarget[]): void {
    for (const target of targets) {
      const key = marketKey(target.symbol, target.exchange);
      this.pendingUnsubscribes.delete(key);
      this.pendingSubscribes.set(key, target);
    }
    this.scheduleFlush();
  }

  private queueUnsubscribes(targets: QuoteStreamTarget[]): void {
    for (const target of targets) {
      const key = marketKey(target.symbol, target.exchange);
      this.pendingSubscribes.delete(key);
      this.pendingUnsubscribes.set(key, target);
    }
    this.scheduleFlush();
  }

  /** Sends what gathered since the last flush; on a connection that is not open it is dropped, as the open replays all. */
  private flushQueued(): void {
    if (!this.link.openSocket()) {
      this.pendingSubscribes.clear();
      this.pendingUnsubscribes.clear();
      return;
    }
    const subscribes = [...this.pendingSubscribes.values()].filter((target) => !isPerpTarget(target));
    const unsubscribes = [...this.pendingUnsubscribes.values()].filter((target) => !isPerpTarget(target));
    const perpsChanged = [...this.pendingSubscribes]
      .filter(([, target]) => isPerpTarget(target))
      .map(([key]) => key);
    const perpsMoved = perpsChanged.length > 0 || [...this.pendingUnsubscribes.values()].some(isPerpTarget);
    this.pendingSubscribes.clear();
    this.pendingUnsubscribes.clear();
    if (perpsMoved) this.syncPerpSubscriptions(new Set(perpsChanged));
    if (unsubscribes.length > 0) {
      this.link.send({
        type: "market.unsubscribe",
        symbols: unsubscribes.map((target) => serializeQuoteStreamTarget(target)),
      });
    }
    if (subscribes.length > 0) {
      this.link.send({
        type: "market.subscribe",
        symbols: subscribes.map((target) => serializeQuoteStreamTarget(target)),
      });
    }
  }
}
