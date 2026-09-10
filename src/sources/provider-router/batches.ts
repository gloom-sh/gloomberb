import type {
  CachedFinancialsTarget,
  MarketDataRequestContext,
  QuoteBatchResult,
  QuoteSubscriptionTarget,
  TickerFinancialsBatchResult,
} from "../../types/data-provider";
import type { Quote, TickerFinancials } from "../../types/financials";
import { canonicalExchange } from "../../utils/exchanges";
import { normalizeTickerFinancialsPriceHistory } from "../../utils/price-history";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { resolveTickerFinancialsQuoteState } from "../../market-data/quotes/resolution";
import { selectCachedResource } from "./cache";
import {
  dropUnusableProviderQuote,
  hasDeepStatementHistory,
  hasDetailedStatementRows,
  isProviderQuoteUsableForCurrentSession,
  quoteWithFreshnessExchange,
  type CachedFinancialsSelection,
} from "./financials";
import type { ProviderRouterCoreDeps } from "./route-types";

export interface ProviderRouterBatchDeps extends ProviderRouterCoreDeps {
  readCachedMergedFinancialsSelection(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
    allowExpired?: boolean,
  ): CachedFinancialsSelection;
  contextFromCachedTarget(target: CachedFinancialsTarget): MarketDataRequestContext;
  hasBrokerContext(context?: MarketDataRequestContext): boolean;
  hasCachedTargetBrokerContext(target: CachedFinancialsTarget): boolean;
  getQuote(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<Quote>;
  getTickerFinancials(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<TickerFinancials>;
}

export class ProviderRouterBatchRoutes {
  constructor(private readonly deps: ProviderRouterBatchDeps) {}

  private needsSingleFinancialsRoute(value: TickerFinancials): boolean {
    return !value.quote || !(hasDetailedStatementRows(value) && hasDeepStatementHistory(value));
  }

  async getQuotesBatch(
    targets: QuoteSubscriptionTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QuoteBatchResult[]> {
    const forceRefresh = options.forceRefresh === true;
    const results = new Array<QuoteBatchResult | null>(targets.length).fill(null);
    const misses: Array<{ index: number; target: QuoteSubscriptionTarget }> = [];

    targets.forEach((target, index) => {
      const context = target.context;
      const entityKey = this.deps.getEntityKey(target.symbol, context?.instrument);
      const variantKeys = this.deps.getTickerVariantCandidates(target.exchange);
      const brokerSourceKeys = this.deps.getBrokerCandidatesForContext(context, false).map((candidate) => this.deps.brokerSourceKey(candidate));
      const sourceKeys = [
        ...brokerSourceKeys,
        ...this.deps.getProviderSourceKeys(),
      ];
      const rawCached = selectCachedResource<Quote>(this.deps.resources, "quote", entityKey, variantKeys, sourceKeys, false);
      const cached = rawCached && !isQuoteStaleForCurrentSession(quoteWithFreshnessExchange(rawCached.value, target.exchange))
        ? rawCached
        : null;
      if (cached && !forceRefresh && !cached.stale) {
        if (brokerSourceKeys.includes(cached.sourceKey)) {
          misses.push({ index, target });
          return;
        }
        results[index] = { target, quote: cached.value };
        return;
      }
      misses.push({ index, target });
    });

    const batchProvider = this.deps.providersInPriorityOrder().find((provider) => provider.getQuotesBatch);
    const providerMisses = misses.filter(({ target }) => !this.deps.hasBrokerContext(target.context));
    const providerIndexes = new Map<string, Array<{ index: number; target: QuoteSubscriptionTarget }>>();
    if (batchProvider && providerMisses.length > 0) {
      for (const entry of providerMisses) {
        const key = this.quoteBatchKey(entry.target);
        const bucket = providerIndexes.get(key) ?? [];
        bucket.push(entry);
        providerIndexes.set(key, bucket);
      }
      const uniqueTargets = [...providerIndexes.values()].map((bucket) => bucket[0]!.target);
      const batchResults = await batchProvider.getQuotesBatch!(uniqueTargets, options).catch(() => []);
      for (const item of batchResults) {
        if (!isProviderQuoteUsableForCurrentSession(item.quote, item.target.exchange)) continue;
        const key = this.quoteBatchKey(item.target);
        const sourceKey = this.deps.providerSourceKey(batchProvider);
        for (const entry of providerIndexes.get(key) ?? []) {
          const entityKey = this.deps.getEntityKey(entry.target.symbol, entry.target.context?.instrument);
          const variantKey = this.deps.getTickerVariantCandidates(entry.target.exchange)[0] ?? "";
          this.deps.cacheResource("quote", entityKey, variantKey, sourceKey, item.quote, this.deps.resolveProviderPolicy("quote", batchProvider));
          results[entry.index] = { target: entry.target, quote: item.quote };
        }
      }
    }

    await Promise.all(misses.map(async ({ index, target }) => {
      if (results[index]) return;
      try {
        const quote = await this.deps.getQuote(target.symbol, target.exchange, {
          ...target.context,
          cacheMode: forceRefresh ? "refresh" : "default",
        });
        results[index] = { target, quote };
      } catch (error) {
        results[index] = { target, quote: null, error };
      }
    }));

    return results.map((result, index) => result ?? { target: targets[index]!, quote: null });
  }

  async getTickerFinancialsBatch(
    targets: CachedFinancialsTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<TickerFinancialsBatchResult[]> {
    const forceRefresh = options.forceRefresh === true;
    const results = new Array<TickerFinancialsBatchResult | null>(targets.length).fill(null);
    const batchFallbacks = new Array<TickerFinancials | null>(targets.length).fill(null);
    const misses: Array<{ index: number; target: CachedFinancialsTarget }> = [];

    targets.forEach((target, index) => {
      const context = this.deps.contextFromCachedTarget(target);
      const cached = this.deps.readCachedMergedFinancialsSelection(target.symbol, target.exchange, context, true);
      if (cached.value?.quote && !forceRefresh && target.statementHistory !== "extended") {
        results[index] = { target, financials: cached.value };
        return;
      }
      misses.push({ index, target });
    });

    const batchProvider = this.deps.providersInPriorityOrder().find((provider) => provider.getTickerFinancialsBatch);
    const providerMisses = misses.filter(({ target }) => target.statementHistory !== "extended" && !this.deps.hasCachedTargetBrokerContext(target));
    const providerIndexes = new Map<string, Array<{ index: number; target: CachedFinancialsTarget }>>();
    if (batchProvider && providerMisses.length > 0) {
      for (const entry of providerMisses) {
        const key = this.cachedFinancialsBatchKey(entry.target);
        const bucket = providerIndexes.get(key) ?? [];
        bucket.push(entry);
        providerIndexes.set(key, bucket);
      }
      const uniqueTargets = [...providerIndexes.values()].map((bucket) => bucket[0]!.target);
      const batchResults = await batchProvider.getTickerFinancialsBatch!(uniqueTargets, options).catch(() => []);
      for (const item of batchResults) {
        if (!item.financials) continue;
        const key = this.cachedFinancialsBatchKey(item.target);
        let value = resolveTickerFinancialsQuoteState(normalizeTickerFinancialsPriceHistory(item.financials));
        if (value) value = dropUnusableProviderQuote(value, item.target.exchange);
        if (!value) continue;
        const sourceKey = this.deps.providerSourceKey(batchProvider);
        for (const entry of providerIndexes.get(key) ?? []) {
          const entityKey = this.deps.getEntityKey(entry.target.symbol, entry.target.instrument ?? undefined);
          const variantKey = this.deps.getTickerVariantCandidates(entry.target.exchange)[0] ?? "";
          this.deps.cacheResource("financials", entityKey, variantKey, sourceKey, value, this.deps.resolveProviderPolicy("financials", batchProvider));
          batchFallbacks[entry.index] = value;
          if (this.needsSingleFinancialsRoute(value)) continue;
          results[entry.index] = { target: entry.target, financials: value };
        }
      }
    }

    await Promise.all(misses.map(async ({ index, target }) => {
      if (results[index]) return;
      try {
        const financials = await this.deps.getTickerFinancials(target.symbol, target.exchange, {
          ...this.deps.contextFromCachedTarget(target),
          cacheMode: forceRefresh ? "refresh" : "default",
        });
        results[index] = { target, financials };
      } catch (error) {
        results[index] = batchFallbacks[index]
          ? { target, financials: batchFallbacks[index] }
          : { target, financials: null, error };
      }
    }));

    return results.map((result, index) => result ?? { target: targets[index]!, financials: null });
  }

  private quoteBatchKey(target: QuoteSubscriptionTarget): string {
    return `${target.symbol.trim().toUpperCase()}:${canonicalExchange(target.exchange ?? "")}`;
  }

  private cachedFinancialsBatchKey(target: CachedFinancialsTarget): string {
    return `${target.symbol.trim().toUpperCase()}:${canonicalExchange(target.exchange ?? "")}`;
  }
}
