import type { DataProvider, MarketDataRequestContext, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import type { BrokerCandidate } from "./brokers";
import { isProviderQuoteUsableForCurrentSession } from "./financials";
import {
  canBrokerServeTarget,
  isCloudRealtimeInstrument,
  resolveBrokerQuoteStreamState,
  type BrokerQuoteStreamState,
} from "./quote-route";

export interface ProviderRouterStreamingDeps {
  providersInPriorityOrder(): DataProvider[];
  getBrokerCandidatesForContext(context?: MarketDataRequestContext, includeFallbackInstances?: boolean): BrokerCandidate[];
  hasBrokerContext(context?: MarketDataRequestContext): boolean;
  brokerSourceKey(candidate: BrokerCandidate): string;
  /** The signed-in account receives real-time cloud quotes. */
  hasRealtimeCloudAccess(): boolean;
  subscribeRealtimeCloudAccess?(listener: () => void): () => void;
  logInfo(message: string, data?: unknown): void;
  logWarn(message: string, data?: unknown): void;
}

type QuoteListener = (target: QuoteSubscriptionTarget, quote: Quote) => void;

interface RoutableTarget {
  target: QuoteSubscriptionTarget;
  /** Broker profiles able to stream this target, in preference order. */
  brokers: BrokerCandidate[];
  /** A broker is considered only for "broker" targets, or when no provider streams. */
  mayUseBroker: boolean;
  cloudRealtimeInstrument: boolean;
}

interface OpenStream {
  /** Indexes of the targets this stream carries. */
  signature: string;
  dispose(): void;
}

interface BrokerWatch {
  /** Open subscriptions routing targets to this profile. */
  subscriptions: number;
  connected: boolean;
}

/** How often an open subscription may ask an offline broker to connect. */
const BROKER_WAKE_INTERVAL_MS = 30_000;

function isBrokerConnected(candidate: BrokerCandidate): boolean {
  try {
    const status = candidate.broker.getStatus?.(candidate.instance);
    return !status || status.state === "connected";
  } catch {
    return false;
  }
}

/** A broker that is down, not merely on its way up, and can be asked to connect. */
function canWakeBroker(candidate: BrokerCandidate): boolean {
  if (typeof candidate.broker.connect !== "function") return false;
  try {
    const state = candidate.broker.getStatus?.(candidate.instance)?.state;
    return state === "disconnected" || state === "error";
  } catch {
    return false;
  }
}

export class ProviderRouterStreamingRoutes {
  /**
   * Broker sessions that sent a delayed quote for an instrument the cloud
   * streams in real time, since they last connected. Kept only while some
   * subscription watches the profile, so the next one tries the broker again.
   */
  private readonly delayedBrokerSessions = new Set<string>();
  private readonly delayedSessionListeners = new Set<() => void>();
  private readonly brokerWatches = new Map<string, BrokerWatch>();
  private readonly brokerWakeAttempts = new Map<string, number>();

  constructor(private readonly deps: ProviderRouterStreamingDeps) {}

  /**
   * Routes each target to the cloud stream or to the broker that holds it.
   * The choice depends on the instrument, the broker's live status and the
   * account's entitlement, never on which pane asked or how visible it is.
   * The subscription moves targets between sources on its own when a broker
   * connects, disconnects or turns out to be delayed.
   */
  subscribeQuotes(targets: QuoteSubscriptionTarget[], onQuote: QuoteListener): () => void {
    const streamingProvider = this.deps.providersInPriorityOrder().find((provider) => typeof provider.subscribeQuotes === "function") ?? null;
    const routable = targets.map((target) => this.describeTarget(target, !streamingProvider));
    const watchedBrokers = new Map<string, BrokerCandidate>();
    for (const entry of routable) {
      if (!entry.mayUseBroker) continue;
      for (const candidate of entry.brokers) watchedBrokers.set(this.deps.brokerSourceKey(candidate), candidate);
    }

    let disposed = false;
    let providerStream: OpenStream | null = null;
    const brokerStreams = new Map<string, OpenStream>();
    // Profiles whose stream failed to open stay on the cloud for this subscription.
    const failedBrokers = new Set<string>();

    const apply = (): void => {
      if (disposed) return;
      const brokerStates = new Map<string, BrokerQuoteStreamState>();
      for (const [key, candidate] of watchedBrokers) {
        this.observeBrokerConnection(key, candidate);
        brokerStates.set(key, failedBrokers.has(key)
          ? "unsupported"
          : resolveBrokerQuoteStreamState(candidate, this.delayedBrokerSessions.has(key)));
      }
      const realtimeCloud = !!streamingProvider && this.deps.hasRealtimeCloudAccess();

      const providerIndexes: number[] = [];
      const brokerGroups = new Map<string, { candidate: BrokerCandidate; indexes: number[] }>();
      routable.forEach((entry, index) => {
        const cloudRealtime = realtimeCloud && entry.cloudRealtimeInstrument;
        const broker = entry.mayUseBroker
          ? entry.brokers.find((candidate) => canBrokerServeTarget(
            brokerStates.get(this.deps.brokerSourceKey(candidate)) ?? "unsupported",
            cloudRealtime,
          ))
          : undefined;
        if (broker) {
          const key = this.deps.brokerSourceKey(broker);
          const group = brokerGroups.get(key) ?? { candidate: broker, indexes: [] };
          group.indexes.push(index);
          brokerGroups.set(key, group);
        } else if (streamingProvider) {
          providerIndexes.push(index);
        }
      });

      // Open replacements before closing what they replace, so a target that
      // stays on the same source never sees a zero-listener gap.
      const retired: OpenStream[] = [];
      const providerSignature = providerIndexes.join(",");
      if ((providerStream?.signature ?? "") !== providerSignature) {
        if (providerStream) retired.push(providerStream);
        providerStream = streamingProvider && providerIndexes.length > 0
          ? this.openProviderStream(streamingProvider, providerIndexes.map((index) => targets[index]!), onQuote, providerSignature)
          : null;
      }
      for (const [key, stream] of brokerStreams) {
        if (brokerGroups.get(key)?.indexes.join(",") === stream.signature) continue;
        retired.push(stream);
        brokerStreams.delete(key);
      }
      let rerouteFailed = false;
      for (const [key, group] of brokerGroups) {
        if (brokerStreams.has(key)) continue;
        try {
          brokerStreams.set(key, this.openBrokerStream(
            key,
            group.candidate,
            group.indexes.map((index) => targets[index]!),
            onQuote,
            group.indexes.join(","),
          ));
        } catch (error) {
          failedBrokers.add(key);
          rerouteFailed = true;
          this.deps.logWarn("Broker quote stream failed to start", {
            broker: key,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const stream of retired) stream.dispose();
      if (rerouteFailed) apply();
    };

    let applyScheduled = false;
    const scheduleApply = () => {
      if (disposed || applyScheduled) return;
      applyScheduled = true;
      queueMicrotask(() => {
        applyScheduled = false;
        apply();
      });
    };

    const watchers: Array<() => void> = [];
    if (watchedBrokers.size > 0) {
      for (const [key, candidate] of watchedBrokers) {
        this.retainBrokerWatch(key, candidate);
        watchers.push(() => this.releaseBrokerWatch(key));
        try {
          const unsubscribe = candidate.broker.subscribeStatus?.(candidate.instance, () => {
            // Read the transition now: a coalesced reroute would miss a
            // reconnect that completes before it runs.
            this.observeBrokerConnection(key, candidate);
            scheduleApply();
          });
          if (unsubscribe) watchers.push(unsubscribe);
        } catch {
          // A broker that cannot report status keeps the route it has now.
        }
      }
      this.delayedSessionListeners.add(scheduleApply);
      watchers.push(() => this.delayedSessionListeners.delete(scheduleApply));
      if (streamingProvider && routable.some((entry) => entry.mayUseBroker && entry.cloudRealtimeInstrument)) {
        const unsubscribe = this.deps.subscribeRealtimeCloudAccess?.(scheduleApply);
        if (unsubscribe) watchers.push(unsubscribe);
      }
    }

    apply();
    // Subscribing to a broker used to connect it on demand. Keep that for a
    // broker that is down, now that its rows wait on the cloud instead.
    for (const [key, candidate] of watchedBrokers) {
      if (failedBrokers.has(key) || resolveBrokerQuoteStreamState(candidate, false) !== "offline") continue;
      this.wakeBroker(key, candidate);
    }

    if (!providerStream && brokerStreams.size === 0) {
      this.deps.logWarn("No provider supports quote streaming", {
        targetCount: targets.length,
      });
      if (watchers.length === 0) return () => {};
    }

    return () => {
      if (disposed) return;
      disposed = true;
      for (const unwatch of watchers) unwatch();
      providerStream?.dispose();
      providerStream = null;
      for (const stream of brokerStreams.values()) stream.dispose();
      brokerStreams.clear();
    };
  }

  private describeTarget(target: QuoteSubscriptionTarget, noStreamingProvider: boolean): RoutableTarget {
    const brokers = this.deps.hasBrokerContext(target.context)
      ? this.deps.getBrokerCandidatesForContext(target.context, false)
        .filter((candidate) => typeof candidate.broker.subscribeQuotes === "function")
      : [];
    const mayUseBroker = brokers.length > 0 && (target.route === "broker" || noStreamingProvider);
    return {
      target,
      brokers,
      mayUseBroker,
      cloudRealtimeInstrument: mayUseBroker && isCloudRealtimeInstrument(target),
    };
  }

  private retainBrokerWatch(key: string, candidate: BrokerCandidate): void {
    const watch = this.brokerWatches.get(key);
    if (watch) watch.subscriptions += 1;
    else this.brokerWatches.set(key, { subscriptions: 1, connected: isBrokerConnected(candidate) });
  }

  private releaseBrokerWatch(key: string): void {
    const watch = this.brokerWatches.get(key);
    if (!watch) return;
    watch.subscriptions -= 1;
    if (watch.subscriptions > 0) return;
    // Nothing observes the session any more, so a reconnect could go unseen.
    this.brokerWatches.delete(key);
    this.delayedBrokerSessions.delete(key);
  }

  /** A connection change starts a new session with its own market data type. */
  private observeBrokerConnection(key: string, candidate: BrokerCandidate): void {
    const watch = this.brokerWatches.get(key);
    if (!watch) return;
    const connected = isBrokerConnected(candidate);
    if (connected === watch.connected) return;
    watch.connected = connected;
    this.delayedBrokerSessions.delete(key);
  }

  private wakeBroker(key: string, candidate: BrokerCandidate): void {
    if (!canWakeBroker(candidate)) return;
    const now = Date.now();
    const lastAttempt = this.brokerWakeAttempts.get(key);
    if (lastAttempt !== undefined && now - lastAttempt < BROKER_WAKE_INTERVAL_MS) return;
    this.brokerWakeAttempts.set(key, now);
    this.deps.logInfo("Connecting broker for quote stream", { broker: key });
    // Its status listener moves the rows over once it connects.
    Promise.resolve()
      .then(() => candidate.broker.connect!(candidate.instance))
      .catch((error: unknown) => {
        this.deps.logWarn("Broker connect for quote stream failed", {
          broker: key,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private openProviderStream(
    provider: DataProvider,
    targets: QuoteSubscriptionTarget[],
    onQuote: QuoteListener,
    signature: string,
  ): OpenStream {
    this.deps.logInfo("Delegating provider quote stream", {
      providerId: provider.id,
      targetCount: targets.length,
    });
    let active = true;
    const unsubscribe = provider.subscribeQuotes!(targets, (target, quote) => {
      if (active && isProviderQuoteUsableForCurrentSession(quote, target.exchange, target.symbol)) {
        onQuote(target, quote);
      }
    });
    return {
      signature,
      dispose: () => {
        active = false;
        unsubscribe();
      },
    };
  }

  private openBrokerStream(
    key: string,
    candidate: BrokerCandidate,
    targets: QuoteSubscriptionTarget[],
    onQuote: QuoteListener,
    signature: string,
  ): OpenStream {
    this.deps.logInfo("Delegating broker quote stream", {
      brokerId: candidate.brokerId,
      brokerInstanceId: candidate.brokerInstanceId,
      targetCount: targets.length,
    });
    let active = true;
    const unsubscribe = candidate.broker.subscribeQuotes!(candidate.instance, targets, (target, quote) => {
      if (!active) return;
      // One unentitled listing does not make the session delayed; only a
      // delayed quote the cloud could replace in real time moves rows.
      if (quote.dataSource === "delayed" && !this.delayedBrokerSessions.has(key) && isCloudRealtimeInstrument(target)) {
        this.markBrokerSessionDelayed(key);
      }
      onQuote(target, quote);
    });
    return {
      signature,
      dispose: () => {
        active = false;
        unsubscribe();
      },
    };
  }

  private markBrokerSessionDelayed(key: string): void {
    if (this.delayedBrokerSessions.has(key)) return;
    this.delayedBrokerSessions.add(key);
    this.deps.logInfo("Broker quote session is delayed", { broker: key });
    for (const listener of [...this.delayedSessionListeners]) listener();
  }
}
