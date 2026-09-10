import type { DataProvider, CachedFinancialsTarget, TickerFinancialsBatchResult, QuoteBatchResult } from "../types/data-provider";
import type { OptionsChain, PricePoint, TickerFinancials } from "../types/financials";
import { canonicalTickerKey, parsePublicTickerKey } from "../utils/exchanges";
import { clipPriceHistoryToRange } from "../time-series/history-window";
import { getPresetResolution, normalizeChartResolutionSupport, TIME_RANGE_ORDER, type ManualChartResolution } from "../time-series/resolution";

export interface SnapshotMarketData {
  financials: ReadonlyArray<readonly [string, TickerFinancials]>;
  intradayHistories?: ReadonlyArray<{
    symbol: string;
    exchange: string;
    resolution: ManualChartResolution;
    points: PricePoint[];
    unavailableReason: string | null;
  }>;
  optionsChains?: ReadonlyArray<readonly [string, OptionsChain]>;
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
  const financials = lookup(snapshot.financials);
  const options = lookup(snapshot.optionsChains ?? []);
  const intraday = lookup((snapshot.intradayHistories ?? []).map((history) => [canonicalTickerKey(history.symbol, history.exchange), history]));
  const history = (symbol: string, exchange?: string, resolution?: string) => {
    const captured = intraday(symbol, exchange);
    if (captured?.unavailableReason) throw new Error(captured.unavailableReason);
    if (captured && resolution && captured.resolution !== resolution) return [];
    return captured?.points ?? financials(symbol, exchange)?.priceHistory;
  };
  const overrides: Partial<DataProvider> = {
    async getTickerFinancials(symbol, exchange, context) {
      return (context?.statementHistory === "extended" ? undefined : financials(symbol, exchange)) ?? fallback.getTickerFinancials(symbol, exchange, context);
    },
    getCachedFinancialsForTargets(targets, settings) {
      const captured = new Map<string, TickerFinancials>();
      const missing: CachedFinancialsTarget[] = [];
      for (const target of targets) {
        const value = target.statementHistory === "extended" ? undefined : financials(target.symbol, target.exchange);
        if (value) captured.set(target.symbol.trim().toUpperCase(), value);
        else missing.push(target);
      }
      const live = missing.length ? fallback.getCachedFinancialsForTargets?.(missing, settings) : undefined;
      const merge = (values?: Map<string, TickerFinancials>) => new Map([...values ?? [], ...captured]);
      return live instanceof Promise ? live.then(merge) : merge(live);
    },
    getTickerFinancialsBatch(targets, settings) {
      return seededBatch(targets, (target): TickerFinancialsBatchResult | undefined => {
        const value = target.statementHistory === "extended" ? undefined : financials(target.symbol, target.exchange);
        return value ? { target, financials: value } : undefined;
      }, (missing) => fallback.getTickerFinancialsBatch?.(missing, settings) ?? Promise.all(missing.map(async (target) => ({
        target, financials: await fallback.getTickerFinancials(target.symbol, target.exchange, target),
      }))));
    },
    async getQuote(symbol, exchange, context) {
      return financials(symbol, exchange)?.quote ?? fallback.getQuote(symbol, exchange, context);
    },
    getQuotesBatch(targets, settings) {
      return seededBatch(targets, (target): QuoteBatchResult | undefined => {
        const quote = financials(target.symbol, target.exchange)?.quote;
        return quote ? { target, quote } : undefined;
      }, (missing) => fallback.getQuotesBatch?.(missing, settings) ?? Promise.all(missing.map(async (target) => ({
        target, quote: await fallback.getQuote(target.symbol, target.exchange, target.context),
      }))));
    },
    async getOptionsChain(symbol, exchange, expirationDate, context) {
      const captured = options(symbol, exchange);
      if (captured) return captured;
      if (!fallback.getOptionsChain) throw new Error(`No options data available for ${symbol}.`);
      return fallback.getOptionsChain(symbol, exchange, expirationDate, context);
    },
    async getPriceHistory(symbol, exchange, range, context) {
      const points = history(symbol, exchange);
      return points ? clipPriceHistoryToRange(points, range) : fallback.getPriceHistory(symbol, exchange, range, context);
    },
    async getPriceHistoryForResolution(symbol, exchange, range, resolution, context) {
      const points = history(symbol, exchange, resolution);
      return points ? clipPriceHistoryToRange(points, range)
        : fallback.getPriceHistoryForResolution?.(symbol, exchange, range, resolution, context)
          ?? fallback.getPriceHistory(symbol, exchange, range, context);
    },
    async getDetailedPriceHistory(symbol, exchange, start, end, resolution, context) {
      const points = history(symbol, exchange, resolution);
      if (!points) return fallback.getDetailedPriceHistory?.(symbol, exchange, start, end, resolution, context) ?? [];
      return points.filter((point) => point.date.getTime() >= start.getTime() && point.date.getTime() < end.getTime());
    },
    getChartResolutionSupport(symbol, exchange, context) {
      return financials(symbol, exchange) || intraday(symbol, exchange) ? SNAPSHOT_RESOLUTIONS
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
