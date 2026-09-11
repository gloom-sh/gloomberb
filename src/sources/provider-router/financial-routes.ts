import { financialHistoryVariants, hasReusableExtendedHistory } from "./statement-history";
import { sanitizeShellFinancialHistory } from "../history-coverage";
import type {
  CachedFinancialsTarget,
  MarketDataRequestContext,
} from "../../types/data-provider";
import type {
  Quote,
  TickerFinancials,
} from "../../types/financials";
import { parseOptionSymbol } from "../../utils/options";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { resolveTickerFinancialsQuoteState } from "../../market-data/quotes/resolution";
import {
  listCachedResources,
  normalizeTicker,
  selectCachedResource,
  sortCachedRecords,
} from "./cache";
import { withBrokerTimeout } from "./brokers";
import {
  hasMeaningfulProfile,
  hasShallowStatementHistory,
  mergeCachedFinancialRecords,
  mergeFinancials,
  mergeRefreshedFinancials,
  quoteWithFreshnessExchange,
  sanitizeCachedFinancials,
  selectCachedQuoteRecord,
  type CachedFinancialsReadOptions,
  type CachedFinancialsSelection,
} from "./financials";
import type { ProviderRouterPrimaryRoutes } from "./primary";
import type { ProviderRouterCoreDeps, SourceResult } from "./route-types";

export interface ProviderRouterFinancialRouteDeps extends Pick<
  ProviderRouterCoreDeps,
  | "resources"
  | "getEntityKey"
  | "getTickerVariantCandidates"
  | "getBrokerCandidatesForContext"
  | "getProviderSourceKeys"
  | "brokerSourceKey"
> {
  primaryRoutes: ProviderRouterPrimaryRoutes;
}

function withoutSessionState(quote: Quote): Quote {
  const fallback = { ...quote };
  delete fallback.marketState;
  delete fallback.sessionConfidence;
  delete fallback.preMarketPrice;
  delete fallback.preMarketChange;
  delete fallback.preMarketChangePercent;
  delete fallback.postMarketPrice;
  delete fallback.postMarketChange;
  delete fallback.postMarketChangePercent;
  return fallback;
}

export class ProviderRouterFinancialRoutes {
  constructor(private readonly deps: ProviderRouterFinancialRouteDeps) {}

  private mergeProviderEnrichment(cached: CachedFinancialsSelection, fresh: SourceResult<TickerFinancials> | null): TickerFinancials {
    const merged = mergeFinancials(cached.value, fresh?.value ?? null)!;
    if (!fresh) return merged;
    const sources = this.deps.getProviderSourceKeys();
    const rank = (source: string) => sources.includes(source) ? sources.indexOf(source) : Number.MAX_SAFE_INTEGER;
    const contributions = (cached.providerRecords ?? []).map((record) => ({ sourceKey: record.sourceKey,
      value: record.sourceKey === fresh.sourceKey ? mergeRefreshedFinancials(record.value, fresh.value) : record.value,
    }));
    if (!contributions.some((entry) => entry.sourceKey === fresh.sourceKey)) contributions.push(fresh);
    contributions.sort((a, b) => rank(a.sourceKey) - rank(b.sourceKey));
    let providerValue: TickerFinancials | null = null;
    for (const contribution of contributions) {
      providerValue = mergeFinancials(providerValue, sanitizeCachedFinancials(contribution.value));
    }
    const authoritative = mergeFinancials(cached.brokerRecord?.value ?? null, providerValue);
    // Keep the existing quote and statement merge, including standalone live
    // quotes; valuation corrections follow their provider/broker contribution.
    return { ...merged, fundamentals: authoritative?.fundamentals };
  }

  getCachedFinancialsForTargets(
    targets: CachedFinancialsTarget[],
    options: { allowExpired?: boolean; includeStaleQuotes?: boolean } = {},
  ): Map<string, TickerFinancials> {
    const results = new Map<string, TickerFinancials>();
    for (const target of targets) {
      const cached = this.readCachedMergedFinancials(target.symbol, target.exchange, {
        statementHistory: target.statementHistory,
        brokerId: target.brokerId,
        brokerInstanceId: target.brokerInstanceId,
        instrument: target.instrument ?? undefined,
      }, options.allowExpired ?? true, {
        includeStaleQuotes: options.includeStaleQuotes,
        includeSymbolProviderFallback: true,
      });
      if (cached) results.set(target.symbol.toUpperCase(), cached);
    }
    return results;
  }

  async getTickerFinancials(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<TickerFinancials> {
    const financials = await this.loadTickerFinancials(ticker, exchange, context);
    if (financials.quote) return financials;
    // Statement depth does not establish quote freshness. Use the same quote
    // fallback route as QQ, including its cache and broker/listing context.
    try {
      const quote = await this.getQuote(ticker, exchange, context);
      return resolveTickerFinancialsQuoteState(financials, quote) ?? financials;
    } catch {
      // Delisted or temporarily unquoted issuers can still have valid accounts.
      return financials;
    }
  }

  private async loadTickerFinancials(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<TickerFinancials> {
    const isOptionTicker =
      parseOptionSymbol(ticker) != null ||
      parseOptionSymbol(context?.instrument?.localSymbol ?? "") != null ||
      context?.instrument?.secType === "OPT";
    const quoteOnlyFinancials = async (base?: TickerFinancials | null): Promise<TickerFinancials> => ({
      ...base,
      quote: await this.getQuote(ticker, exchange, context),
      annualStatements: base?.annualStatements ?? [],
      quarterlyStatements: base?.quarterlyStatements ?? [],
      priceHistory: base?.priceHistory ?? [],
    });
    const cached = this.readCachedMergedFinancialsSelection(ticker, exchange, context, context?.statementHistory === "extended", {
      includeSymbolProviderFallback: true,
    });
    const forceRefresh = context?.cacheMode === "refresh";
    if (cached.value && !forceRefresh && (context?.statementHistory !== "extended" || hasReusableExtendedHistory(cached.value))) {
      if (context?.statementHistory === "extended" && !cached.stale) return cached.value;
      if (isOptionTicker && !cached.value.quote) {
        return quoteOnlyFinancials(cached.value);
      }
      if (context?.statementHistory !== "extended" && !cached.stale && hasMeaningfulProfile(cached.value) && hasShallowStatementHistory(cached.value)) {
        const providerResult = await this.deps.primaryRoutes.fetchProviderFinancials(ticker, exchange, context);
        return this.mergeProviderEnrichment(cached, providerResult);
      }
      if (!cached.stale && hasMeaningfulProfile(cached.value)) {
        return cached.value;
      }
      if (!hasMeaningfulProfile(cached.value) && !cached.stale) {
        const providerResult = await this.deps.primaryRoutes.fetchProviderFinancials(ticker, exchange, context);
        return this.mergeProviderEnrichment(cached, providerResult);
      }
    }

    if (cached.value) {
      const brokerResult = await withBrokerTimeout(this.deps.primaryRoutes.fetchBrokerFinancials(ticker, exchange, context));
      const providerResult = await this.deps.primaryRoutes.fetchProviderFinancials(ticker, exchange, context);
      const merged = mergeFinancials(
        brokerResult?.value ?? cached.brokerRecord?.value ?? null,
        context?.statementHistory === "extended"
          ? mergeFinancials(providerResult?.value ?? null, cached.providerValue)
          : providerResult?.value ?? cached.providerValue ?? null,
      );
      if (isOptionTicker && !merged?.quote) {
        return quoteOnlyFinancials(merged ?? cached.value);
      }
      return merged ?? cached.value;
    }

    const brokerResult = await withBrokerTimeout(this.deps.primaryRoutes.fetchBrokerFinancials(ticker, exchange, context));
    const fallback = await this.deps.primaryRoutes.fetchProviderFinancials(ticker, exchange, context);
    const merged = mergeFinancials(brokerResult?.value ?? null, fallback?.value ?? null);
    if (isOptionTicker && !merged?.quote) {
      return quoteOnlyFinancials(merged);
    }
    if (!merged) {
      throw new Error(`No provider available for ${ticker}`);
    }
    return merged;
  }

  async getQuote(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<Quote> {
    const entityKey = this.deps.getEntityKey(ticker, context?.instrument);
    const variantKeys = this.deps.getTickerVariantCandidates(exchange);
    const brokerSourceKeys = this.deps.getBrokerCandidatesForContext(context, false).map((candidate) => this.deps.brokerSourceKey(candidate));
    const sourceKeys = [
      ...brokerSourceKeys,
      ...this.deps.getProviderSourceKeys(),
    ];
    const rawCached = selectCachedResource<Quote>(this.deps.resources, "quote", entityKey, variantKeys, sourceKeys, false);
    const cached = rawCached && !isQuoteStaleForCurrentSession(quoteWithFreshnessExchange(rawCached.value, exchange))
      ? rawCached
      : null;
    const forceRefresh = context?.cacheMode === "refresh";
    if (cached && !forceRefresh && !cached.stale) {
      if (!brokerSourceKeys.includes(cached.sourceKey)) return cached.value;
      return this.mergeBrokerQuoteWithProviderReference(
        cached.value,
        await this.getProviderReferenceQuote(ticker, exchange, context),
      );
    }

    const brokerQuote = await withBrokerTimeout(this.deps.primaryRoutes.fetchBrokerQuote(ticker, exchange, context));
    if (brokerQuote && !isQuoteStaleForCurrentSession(quoteWithFreshnessExchange(brokerQuote.value, exchange))) {
      return this.mergeBrokerQuoteWithProviderReference(
        brokerQuote.value,
        await this.getProviderReferenceQuote(ticker, exchange, context),
      );
    }

    const providerQuote = await this.deps.primaryRoutes.fetchProviderQuote(ticker, exchange, context);
    if (providerQuote) {
      return providerQuote.value;
    }
    if (cached) return cached.value;
    throw new Error(`No quote provider available for ${ticker}`);
  }

  private async getProviderReferenceQuote(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<Quote | null> {
    const cached = context?.cacheMode === "refresh"
      ? null
      : this.readCachedProviderQuote(ticker, exchange, context);
    if (cached) return cached;
    const staleFallback = this.readCachedProviderQuote(ticker, exchange, context, true);
    const providerQuote = await this.deps.primaryRoutes.fetchProviderQuote(ticker, exchange, context);
    if (providerQuote) return providerQuote.value;
    return staleFallback ? withoutSessionState(staleFallback) : null;
  }

  private readCachedProviderQuote(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
    includeStale = false,
  ): Quote | null {
    const entityKey = this.deps.getEntityKey(ticker, context?.instrument);
    const entityKeys = [...new Set([entityKey, normalizeTicker(ticker)])];
    const variantKeys = this.deps.getTickerVariantCandidates(exchange);
    const sourceKeys = this.deps.getProviderSourceKeys();
    for (const candidateEntityKey of entityKeys) {
      const record = selectCachedResource<Quote>(this.deps.resources, "quote", candidateEntityKey, variantKeys, sourceKeys, false);
      if (
        record
        && (includeStale || !record.stale)
        && !isQuoteStaleForCurrentSession(quoteWithFreshnessExchange(record.value, exchange))
      ) {
        return record.value;
      }
    }
    return null;
  }

  private mergeBrokerQuoteWithProviderReference(brokerQuote: Quote, providerQuote: Quote | null): Quote {
    if (!providerQuote) return brokerQuote;
    return resolveTickerFinancialsQuoteState({
      quote: providerQuote,
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
    }, brokerQuote)?.quote ?? brokerQuote;
  }

  readCachedMergedFinancialsSelection(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
    allowExpired = false,
    options: CachedFinancialsReadOptions = {},
  ): CachedFinancialsSelection {
    const entityKey = this.deps.getEntityKey(ticker, context?.instrument);
    const quoteVariantKeys = this.deps.getTickerVariantCandidates(exchange);
    const variantKeys = financialHistoryVariants(quoteVariantKeys, context);
    const brokerSourceKeys = this.deps.getBrokerCandidatesForContext(context, false).map((candidate) => this.deps.brokerSourceKey(candidate));
    const brokerRecord = brokerSourceKeys.length > 0
      ? selectCachedResource<TickerFinancials>(this.deps.resources, "financials", entityKey, quoteVariantKeys, brokerSourceKeys, allowExpired)
      : null;
    const sanitizedBrokerRecord = brokerRecord
      ? { ...brokerRecord, value: sanitizeCachedFinancials(brokerRecord.value, options) }
      : null;
    const providerSourceKeys = this.deps.getProviderSourceKeys();
    const includeSymbolProviderFallback = options.includeSymbolProviderFallback !== false;
    const providerEntityKeys = includeSymbolProviderFallback
      ? [...new Set([entityKey, normalizeTicker(ticker)])]
      : [entityKey];
    const providerRecords = sortCachedRecords(
      providerEntityKeys.flatMap((providerEntityKey) => listCachedResources<TickerFinancials>(
        this.deps.resources,
        "financials",
        providerEntityKey,
        variantKeys,
        providerSourceKeys,
        allowExpired,
      ).map((record) => {
        const value = sanitizeShellFinancialHistory(record.value, { symbol: ticker, exchange }, record.sourceKey);
        return value === record.value ? record : { ...record, value, stale: true };
      })),
      variantKeys,
      providerSourceKeys,
    );
    const providerSelection = mergeCachedFinancialRecords(
      providerRecords,
      options,
    );
    const quoteSourceKeys = [...brokerSourceKeys, ...providerSourceKeys];
    const quoteRecords = sortCachedRecords(
      providerEntityKeys.flatMap((quoteEntityKey) => listCachedResources<Quote>(
        this.deps.resources,
        "quote",
        quoteEntityKey,
        quoteVariantKeys,
        quoteSourceKeys,
        allowExpired,
      )),
      quoteVariantKeys,
      quoteSourceKeys,
    );
    const quoteSelection = selectCachedQuoteRecord(quoteRecords, exchange, options);
    const mergedValue = mergeFinancials(sanitizedBrokerRecord?.value ?? null, providerSelection.value);
    const value = quoteSelection.quote
      ? resolveTickerFinancialsQuoteState(mergedValue, quoteSelection.quote)
      : mergedValue;
    return {
      brokerRecord: sanitizedBrokerRecord,
      providerRecords,
      providerValue: providerSelection.value,
      value,
      stale: (sanitizedBrokerRecord?.stale ?? false) || providerSelection.stale || quoteSelection.stale,
    };
  }

  private readCachedMergedFinancials(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
    allowExpired = false,
    options: CachedFinancialsReadOptions = {},
  ): TickerFinancials | null {
    return this.readCachedMergedFinancialsSelection(ticker, exchange, context, allowExpired, options).value;
  }
}
