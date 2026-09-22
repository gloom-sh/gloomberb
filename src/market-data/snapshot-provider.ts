import type { MarketDataRequestContext, DataProvider, CachedFinancialsTarget, TickerFinancialsBatchResult, QuoteBatchResult } from "../types/data-provider";
import type { OptionsChain, PricePoint, Quote, TickerFinancials } from "../types/financials";
import { canonicalExchange, canonicalTickerKey, parsePublicTickerKey } from "../utils/exchanges";
import { clipPriceHistoryToRange } from "../time-series/history-window";
import { getPresetResolution, normalizeChartResolutionSupport, TIME_RANGE_ORDER, type ManualChartResolution } from "../time-series/resolution";
import type { InstrumentRef } from "./request-types";
import { instrumentIdentityKey } from "../utils/instrument-identity";
import { quoteMetadataFromQuote } from "./quotes/metadata";
import { getPricePointTimestamp } from "../utils/price-history";

/** Omitted expiry retains a legacy/default slice; the catalogue is not its identity. */
export type SnapshotOptionsChain = readonly [symbol: string, chain: OptionsChain, expirationDate?: number];

export interface SnapshotMarketData {
  financials: ReadonlyArray<readonly [string, TickerFinancials]>;
  instrumentFinancials?: ReadonlyArray<{ instrument: InstrumentRef; financials: TickerFinancials }>;
  /** Separate acquired cadences for an instrument used by more than one research series. */
  historyVariants?: ReadonlyArray<{ target: InstrumentRef; resolution: ManualChartResolution | null; requestKey?: string; points: PricePoint[] }>;
  intradayHistories?: ReadonlyArray<{
    target?: InstrumentRef;
    symbol: string;
    exchange: string;
    resolution: ManualChartResolution;
    points: PricePoint[];
    unavailableReason: string | null;
    /** Metadata already fetched to validate the captured history's price domain. */
    quote?: Quote;
  }>;
  optionsChains?: ReadonlyArray<SnapshotOptionsChain>;
}

/** Exact captured identity, retaining the snapshot API's public venue alias matching. */
export function snapshotInstrumentKey(instrument: InstrumentRef): string {
  const parsed = parsePublicTickerKey(instrument.symbol);
  return instrumentIdentityKey({ ...instrument, symbol: parsed.symbol,
    exchange: canonicalExchange(parsed.exchange ?? instrument.exchange),
    brokerId: instrument.brokerId ?? instrument.instrument?.brokerId,
    brokerInstanceId: instrument.brokerInstanceId ?? instrument.instrument?.brokerInstanceId,
  });
}

/** A captured result is authoritative; trying another interval cannot repair it. */
export class SnapshotHistoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotHistoryUnavailableError";
  }
}

const SNAPSHOT_RESOLUTIONS = normalizeChartResolutionSupport(
  TIME_RANGE_ORDER.map((maxRange) => ({ resolution: getPresetResolution(maxRange), maxRange })),
);

function lookup<T>(entries: ReadonlyArray<readonly [string, T]>) {
  const values = new Map(entries.map(([key, value]) => {
    const { symbol, exchange } = parsePublicTickerKey(key);
    return [canonicalTickerKey(symbol, exchange), value] as const;
  }));
  return (symbol: string, exchange?: string) => (
    values.get(canonicalTickerKey(symbol, exchange)) ?? values.get(canonicalTickerKey(symbol))
  );
}

function optionsLookup(entries: ReadonlyArray<SnapshotOptionsChain>) {
  const values = new Map<string, Map<number | undefined, OptionsChain>>();
  for (const [key, chain, expirationDate] of entries) {
    const { symbol, exchange } = parsePublicTickerKey(key);
    const identity = canonicalTickerKey(symbol, exchange);
    const expiries = values.get(identity) ?? new Map<number | undefined, OptionsChain>();
    values.set(identity, expiries);
    if (expirationDate === undefined) expiries.set(undefined, chain);
    // Legacy OMON captures have no requested-expiry field. Their contracts can
    // establish a slice, but expirationDates lists every available slice.
    const contractExpiries = new Set([...chain.calls, ...chain.puts].map((contract) => contract.expiration));
    const representedExpiry = expirationDate ?? (contractExpiries.size === 1 ? [...contractExpiries][0] : undefined);
    if (representedExpiry !== undefined && Number.isFinite(representedExpiry) && representedExpiry > 0) {
      expiries.set(representedExpiry, chain);
    }
  }
  return (symbol: string, exchange?: string, expirationDate?: number) => {
    for (const key of [canonicalTickerKey(symbol, exchange), canonicalTickerKey(symbol)]) {
      const expiries = values.get(key);
      if (!expiries) continue;
      const exact = expiries.get(expirationDate);
      if (exact) return exact;
      if (expirationDate === undefined) {
        const firstExpiry = [...expiries.keys()].filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
        if (firstExpiry !== undefined) return expiries.get(firstExpiry);
      }
    }
    return undefined;
  };
}

async function seededBatch<T, R>(targets: T[], find: (target: T) => R | undefined, load: (missing: T[]) => Promise<R[]>): Promise<R[]> {
  const results = targets.map(find);
  const missing = targets.filter((_, index) => results[index] === undefined);
  if (!missing.length) return results as R[];
  const loaded = await load(missing);
  let index = 0;
  return results.map((result) => result ?? loaded[index++]!);
}

/** A captured dataset wins for its instruments; everything else uses the live provider. */
export function createSnapshotDataProvider(snapshot: SnapshotMarketData, fallback: DataProvider): DataProvider {
  const publicFinancials = lookup(snapshot.financials);
  const exactFinancials = new Map((snapshot.instrumentFinancials ?? []).map(entry => [snapshotInstrumentKey(entry.instrument), entry.financials]));
  const financials = (symbol: string, exchange?: string, context?: MarketDataRequestContext) =>
    exactFinancials.get(snapshotInstrumentKey({ symbol, exchange, ...context }))
      ?? (context?.instrument ? undefined : publicFinancials(symbol, exchange));
  const financialsForRequest = (symbol: string, exchange?: string, context?: MarketDataRequestContext) => {
    const captured = financials(symbol, exchange, context);
    if (context?.statementHistory !== "extended") return captured;
    const attempt = captured?.statementHistory;
    // A settled unsupported response preserves the captured coverage limit;
    // ordinary bundles and failed extensions still require the live route.
    return attempt?.mode === "extended" && (attempt.status === "available" || attempt.status === "unsupported")
      ? captured : undefined;
  };
  const options = optionsLookup(snapshot.optionsChains ?? []);
  const publicIntraday = lookup((snapshot.intradayHistories ?? []).filter(history => !history.target?.instrument)
    .map(history => [canonicalTickerKey(history.symbol, history.exchange), history]));
  const exactIntraday = new Map((snapshot.intradayHistories ?? []).flatMap(history => history.target ? [[snapshotInstrumentKey(history.target), history] as const] : []));
  const intraday = (symbol: string, exchange?: string, context?: MarketDataRequestContext) =>
    exactIntraday.get(snapshotInstrumentKey({ symbol, exchange, ...context }))
      ?? (context?.instrument ? undefined : publicIntraday(symbol, exchange));
  const variants = new Map<string, NonNullable<SnapshotMarketData["historyVariants"]>[number][]>();
  for (const entry of snapshot.historyVariants ?? []) {
    const key = snapshotInstrumentKey(entry.target);
    variants.set(key, [...variants.get(key) ?? [], entry]);
  }
  const historyVariants = (symbol: string, exchange?: string, context?: MarketDataRequestContext) =>
    variants.get(snapshotInstrumentKey({ symbol, exchange, ...context }));
  type CapturedHistory = { points: PricePoint[]; resolution: ManualChartResolution | null | undefined };
  const history = (symbol: string, exchange?: string, resolution?: string, context?: MarketDataRequestContext): CapturedHistory | undefined => {
    const missing: CapturedHistory = { points: [], resolution: null };
    const captured = intraday(symbol, exchange, context);
    if (captured?.unavailableReason) throw new SnapshotHistoryUnavailableError(captured.unavailableReason);
    if (captured && resolution && captured.resolution !== resolution) return missing;
    if (captured) return captured;
    const alternatives = historyVariants(symbol, exchange, context);
    if (alternatives?.length) {
      const requested = context?.historyRequestKey
        ? alternatives.find(entry => entry.requestKey === context.historyRequestKey) : undefined;
      if (requested) return resolution && requested.resolution !== resolution ? missing : requested;
      if (resolution) return alternatives.find(entry => entry.resolution === resolution) ?? missing;
      const opaque = alternatives.filter(entry => entry.resolution === null);
      if (opaque.length) return opaque.length === 1 && (!context?.historyRequestKey || !opaque[0]!.requestKey)
        ? opaque[0] : missing;
      return alternatives[0];
    }
    const data = financials(symbol, exchange, context);
    // Absent metadata retains old captures' behavior. Explicit unknown is not
    // evidence for any requested interval; AUTO can still use its raw history.
    if (data && resolution && data.priceHistoryResolution !== undefined && data.priceHistoryResolution !== resolution) return missing;
    if (data?.priceHistoryResolution === null && data.priceHistoryRequestKey && context?.historyRequestKey
      && data.priceHistoryRequestKey !== context.historyRequestKey) return missing;
    return data ? { points: data.priceHistory, resolution: data.priceHistoryResolution } : undefined;
  };
  const overrides: Partial<DataProvider> = {
    async getTickerFinancials(symbol, exchange, context) {
      return financialsForRequest(symbol, exchange, context) ?? fallback.getTickerFinancials(symbol, exchange, context);
    },
    getCachedFinancialsForTargets(targets, settings) {
      const captured = new Map<string, TickerFinancials>();
      const missing: CachedFinancialsTarget[] = [];
      // This legacy cache API returns one entry per symbol. Distinct targets
      // cannot be represented there; the identity-bearing batch API can.
      const identities = new Map<string, Set<string>>();
      for (const target of targets) {
        const symbol = target.symbol.trim().toUpperCase();
        const keys = identities.get(symbol) ?? new Set<string>();
        keys.add(snapshotInstrumentKey(target));
        identities.set(symbol, keys);
      }
      for (const target of targets) {
        if (identities.get(target.symbol.trim().toUpperCase())!.size > 1) continue;
        const value = financialsForRequest(target.symbol, target.exchange, target);
        if (value) captured.set(target.symbol.trim().toUpperCase(), value);
        else missing.push(target);
      }
      const live = missing.length ? fallback.getCachedFinancialsForTargets?.(missing, settings) : undefined;
      const merge = (values?: Map<string, TickerFinancials>) => new Map([...values ?? [], ...captured]);
      return live instanceof Promise ? live.then(merge) : merge(live);
    },
    getTickerFinancialsBatch(targets, settings) {
      return seededBatch(targets, (target): TickerFinancialsBatchResult | undefined => {
        const value = financialsForRequest(target.symbol, target.exchange, target);
        return value ? { target, financials: value } : undefined;
      }, (missing) => fallback.getTickerFinancialsBatch?.(missing, settings) ?? Promise.all(missing.map(async (target) => ({
        target, financials: await fallback.getTickerFinancials(target.symbol, target.exchange, target),
      }))));
    },
    async getQuote(symbol, exchange, context) {
      return intraday(symbol, exchange, context)?.quote ?? financials(symbol, exchange, context)?.quote ?? fallback.getQuote(symbol, exchange, context);
    },
    async getQuoteMetadata(symbol, exchange, context) {
      const captured = financials(symbol, exchange, context);
      if (captured?.quoteMetadata) return captured.quoteMetadata;
      const quote = intraday(symbol, exchange, context)?.quote ?? captured?.quote;
      if (quote) return quoteMetadataFromQuote(quote);
      return fallback.getQuoteMetadata?.(symbol, exchange, context)
        ?? fallback.getQuote(symbol, exchange, context).then(quoteMetadataFromQuote);
    },
    getQuotesBatch(targets, settings) {
      return seededBatch(targets, (target): QuoteBatchResult | undefined => {
        const quote = intraday(target.symbol, target.exchange, target.context)?.quote ?? financials(target.symbol, target.exchange, target.context)?.quote;
        return quote ? { target, quote } : undefined;
      }, (missing) => fallback.getQuotesBatch?.(missing, settings) ?? Promise.all(missing.map(async (target) => ({
        target, quote: await fallback.getQuote(target.symbol, target.exchange, target.context),
      }))));
    },
    async getOptionsChain(symbol, exchange, expirationDate, context) {
      const captured = context?.instrument ? undefined : options(symbol, exchange, expirationDate);
      if (captured) return captured;
      if (!fallback.getOptionsChain) throw new Error(`No options data available for ${symbol}.`);
      return fallback.getOptionsChain(symbol, exchange, expirationDate, context);
    },
    async getPriceHistory(symbol, exchange, range, context) {
      const captured = history(symbol, exchange, undefined, context);
      return captured ? clipPriceHistoryToRange(captured.points, range) : fallback.getPriceHistory(symbol, exchange, range, context);
    },
    async getPriceHistoryWithMetadata(symbol, exchange, range, context) {
      const captured = history(symbol, exchange, undefined, context);
      if (captured) return { points: clipPriceHistoryToRange(captured.points, range), resolution: captured.resolution ?? null };
      if (fallback.getPriceHistoryWithMetadata) return fallback.getPriceHistoryWithMetadata(symbol, exchange, range, context);
      return { points: await fallback.getPriceHistory(symbol, exchange, range, context), resolution: null };
    },
    async getPriceHistoryForResolution(symbol, exchange, range, resolution, context) {
      const captured = history(symbol, exchange, resolution, context);
      return captured ? clipPriceHistoryToRange(captured.points, range)
        : fallback.getPriceHistoryForResolution?.(symbol, exchange, range, resolution, context) ?? [];
    },
    async getDetailedPriceHistory(symbol, exchange, start, end, resolution, context) {
      const captured = history(symbol, exchange, resolution, context);
      if (!captured) return fallback.getDetailedPriceHistory?.(symbol, exchange, start, end, resolution, context) ?? [];
      return captured.points.filter((point) => getPricePointTimestamp(point) >= start.getTime() && getPricePointTimestamp(point) < end.getTime());
    },
    getChartResolutionSupport(symbol, exchange, context) {
      const captured = intraday(symbol, exchange, context);
      const alternatives = historyVariants(symbol, exchange, context);
      const data = financials(symbol, exchange, context);
      const resolutions = captured ? [captured.resolution] : alternatives?.map(entry => entry.resolution)
        ?? (data?.priceHistoryResolution !== undefined ? [data.priceHistoryResolution] : null);
      if (resolutions) return normalizeChartResolutionSupport(resolutions.flatMap(resolution => resolution ? [{ resolution, maxRange: "ALL" as const }] : []));
      return data ? SNAPSHOT_RESOLUTIONS
        : fallback.getChartResolutionSupport?.(symbol, exchange, context) ?? SNAPSHOT_RESOLUTIONS;
    },
  };
  return new Proxy(fallback, {
    get(target, property) {
      // A live query handle could bypass the captured options through the
      // coordinator. Live fallback methods still use their provider's cache.
      if (property === "getCachedQuery") return undefined;
      const value = Reflect.get(overrides, property) ?? Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
