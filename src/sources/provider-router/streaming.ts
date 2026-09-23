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

export class ProviderRouterStreamingRoutes {
  /** Broker sessions that delivered delayed quotes since they last connected. */
  private readonly delayedBrokerSessions = new Set<string>();
  private readonly delayedSessionListeners = new Set<() => void>();

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
        const state = failedBrokers.has(key)
          ? "unsupported"
          : resolveBrokerQuoteStreamState(candidate, this.delayedBrokerSessions.has(key));
        // A reconnect resets the broker's market data type, so start over.
        if (state === "offline") this.delayedBrokerSessions.delete(key);
        brokerStates.set(key, state);
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
      for (const candidate of watchedBrokers.values()) {
        try {
          const unsubscribe = candidate.broker.subscribeStatus?.(candidate.instance, scheduleApply);
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
      if (quote.dataSource === "delayed") this.markBrokerSessionDelayed(key);
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
