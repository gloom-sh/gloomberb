import { MarketDataType, type Contract, type ContractDetails, type IBApiNext } from "@stoqey/ib";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { debugLog } from "../../../utils/debug-log";
import type { BrokerContractRef } from "../../../types/instrument";
import type { IbkrGatewayConfig } from "./types";
import {
  buildQuoteStreamKey,
  normalizeQuoteStreamTarget,
} from "./market-data";
import { getIbkrPriceDivisor } from "./price-normalization";
import {
  applyMarketDataQuoteStreamUpdate,
  applyTickByTickAllLastStreamUpdate,
  applyTickByTickBidAskStreamUpdate,
  IBKR_QUOTE_STREAM_TICKS,
  loadIbkrSeedQuote,
  startIbkrTickByTickBidAskStream,
  type ActiveQuoteStream,
  type QuoteStreamListener,
} from "./quote-stream";
import { IBKR_DATA_TIMEOUT, withTimeout } from "./timeouts";

interface QuoteStreamRuntime {
  connect(config: IbkrGatewayConfig): Promise<void>;
  getApi(): IBApiNext;
  getRawApi(): any;
  getActiveMarketDataType(): MarketDataType;
  resolveContract(symbol: string, exchange: string, instrument: BrokerContractRef | null): Promise<Contract>;
  getPrimaryContractDetails(contract: Contract): Promise<ContractDetails>;
  withMarketDataFallback<T>(operation: () => Promise<T>): Promise<T>;
}

const gatewayLog = debugLog.createLogger("ibkr-gateway");

export class IbkrQuoteStreamController {
  private readonly quoteStreams = new Map<string, ActiveQuoteStream>();
  private readonly quoteStreamStarts = new Map<string, Promise<void>>();

  constructor(
    private readonly runtime: QuoteStreamRuntime,
    private readonly instanceId?: string,
  ) {}

  subscribe(
    config: IbkrGatewayConfig,
    targets: QuoteSubscriptionTarget[],
    onQuote: QuoteStreamListener,
  ): () => void {
    const uniqueTargets = [...new Map(
      targets
        .map((target) => normalizeQuoteStreamTarget(target))
        .filter((target): target is QuoteSubscriptionTarget => target != null)
        .map((target) => [buildQuoteStreamKey(target), target] as const),
    ).values()];

    for (const target of uniqueTargets) {
      const key = buildQuoteStreamKey(target);
      const stream = this.quoteStreams.get(key) ?? {
        target,
        listeners: new Map<QuoteStreamListener, QuoteSubscriptionTarget>(),
        stop: () => {},
      };
      stream.target = target;
      stream.listeners.set(onQuote, target);
      this.quoteStreams.set(key, stream);

      if (!this.quoteStreamStarts.has(key) && stream.listeners.size === 1) {
        const startPromise = this.ensureQuoteStream(key, target, config)
          .catch((error) => {
            gatewayLog.warn("Quote stream setup failed", {
              instanceId: this.instanceId,
              symbol: target.symbol,
              exchange: target.exchange ?? "",
              error: error instanceof Error ? error.message : String(error ?? ""),
            });
          })
          .finally(() => {
            this.quoteStreamStarts.delete(key);
          });
        this.quoteStreamStarts.set(key, startPromise);
      }
    }

    return () => {
      for (const target of uniqueTargets) {
        const key = buildQuoteStreamKey(target);
        const stream = this.quoteStreams.get(key);
        if (!stream) continue;
        stream.listeners.delete(onQuote);
        if (stream.listeners.size === 0) {
          stream.stop();
          this.quoteStreams.delete(key);
        }
      }
    };
  }

  teardown(): void {
    for (const stream of this.quoteStreams.values()) {
      stream.stop();
    }
    this.quoteStreams.clear();
    this.quoteStreamStarts.clear();
  }

  private async ensureQuoteStream(
    key: string,
    target: QuoteSubscriptionTarget,
    config: IbkrGatewayConfig,
  ): Promise<void> {
    await this.runtime.connect(config);
    const contract = await withTimeout(
      this.runtime.resolveContract(target.symbol, target.exchange ?? "", target.context?.instrument ?? null),
      IBKR_DATA_TIMEOUT,
      "resolveContract",
    );
    const details = await withTimeout(this.runtime.getPrimaryContractDetails(contract), IBKR_DATA_TIMEOUT, "getContractDetails");
    const priceDivisor = getIbkrPriceDivisor(contract, details);
    const stream = this.quoteStreams.get(key);
    if (!stream || stream.listeners.size === 0) {
      this.quoteStreams.delete(key);
      return;
    }

    const seededQuote = await loadIbkrSeedQuote({
      api: this.runtime.getApi(),
      activeMarketDataType: this.runtime.getActiveMarketDataType(),
      contract,
      details,
      withMarketDataFallback: (operation) => this.runtime.withMarketDataFallback(operation),
    });
    if (seededQuote) {
      stream.lastQuote = seededQuote;
      for (const [listener, listenerTarget] of stream.listeners.entries()) {
        listener(listenerTarget, seededQuote);
      }
    }

    const subscription = this.runtime.getApi().getMarketData(contract, IBKR_QUOTE_STREAM_TICKS, false, false).subscribe({
      next: (update) => applyMarketDataQuoteStreamUpdate(
        this.quoteStreams.get(key),
        contract,
        details,
        update,
        this.runtime.getActiveMarketDataType(),
      ),
      error: (error) => {
        gatewayLog.warn("Quote stream error", {
          instanceId: this.instanceId,
          symbol: target.symbol,
          exchange: target.exchange ?? "",
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
      },
    });
    const tradeSubscription = this.runtime.getApi().getTickByTickAllLastDataUpdates(contract, 0, false).subscribe({
      next: (tick) => applyTickByTickAllLastStreamUpdate(
        this.quoteStreams.get(key),
        contract,
        details,
        tick,
        priceDivisor,
        this.runtime.getActiveMarketDataType(),
      ),
      error: (error) => {
        gatewayLog.warn("Tick-by-tick trade stream error", {
          instanceId: this.instanceId,
          symbol: target.symbol,
          exchange: target.exchange ?? "",
          error: error instanceof Error ? error.message : String(error ?? ""),
        });
      },
    });
    const bidAskStop = startIbkrTickByTickBidAskStream({
      api: this.runtime.getApi(),
      rawApi: this.runtime.getRawApi(),
      contract,
      onUpdate: (update) => applyTickByTickBidAskStreamUpdate(this.quoteStreams.get(key), update, priceDivisor),
      onError: (error) => {
        gatewayLog.warn("Tick-by-tick bid/ask stream error", {
          instanceId: this.instanceId,
          symbol: target.symbol,
          exchange: target.exchange ?? "",
          error,
        });
      },
    });

    const liveStream = this.quoteStreams.get(key);
    if (!liveStream || liveStream.listeners.size === 0) {
      subscription.unsubscribe();
      tradeSubscription.unsubscribe();
      bidAskStop();
      this.quoteStreams.delete(key);
      return;
    }
    liveStream.stop = () => {
      subscription.unsubscribe();
      tradeSubscription.unsubscribe();
      bidAskStop();
    };
  }
}
