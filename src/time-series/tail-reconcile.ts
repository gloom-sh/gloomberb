import { logFailure } from "../utils/log-failure";
import { fetchHistoryResult } from "../sources/history-result";
import type { PriceHistoryResult } from "../types/price-history";
import { CHART_RESOLUTION_STEP_MS } from "./resolution";
import type { DataProvider } from "../types/data-provider";
import type { TickerFinancials } from "../types/financials";
import { getPricePointTimestamp } from "../utils/price-history";
import { type ChartResolveSources, type ChartResolveCache, requestContext } from "./resolve-context";
import { DAY_MS } from "./chart-bounds";
import { priceHistoryAcquisitionIdentity, priceHistoryTailAcquisition, mergePriceHistoryWindows } from "./history-acquisition";

/** Recent-window requests for the same history, shared by every chart asking at once. */
const tailRequestsInFlight = new WeakMap<DataProvider, Map<string, Promise<PriceHistoryResult | null>>>();

/** Older tails are left to a full history refresh rather than a recent-window request. */
const MAX_TAIL_RECONCILE_LAG_MS = 3 * DAY_MS;

function latestObservationTime(points: TickerFinancials["priceHistory"]): number {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    const time = getPricePointTimestamp(point);
    if (Number.isFinite(time) && Number.isFinite(point.close)) return time;
  }
  return Number.NaN;
}

function samePricePoints(left: TickerFinancials["priceHistory"], right: TickerFinancials["priceHistory"]): boolean {
  if (left.length !== right.length) return false;
  for (let index = left.length - 1; index >= 0; index -= 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    if (getPricePointTimestamp(a) !== getPricePointTimestamp(b) || a.open !== b.open || a.high !== b.high
      || a.low !== b.low || a.close !== b.close || a.volume !== b.volume) return false;
  }
  return true;
}

/**
 * Refreshes the newest bars of each intraday history the last resolve plotted
 * up to the present, so bars formed from quotes settle to the provider's
 * version shortly after they close. Only the recent window is requested, and a
 * window from a different source or session contract is never mixed in.
 * Resolves true when any plotted bar changed.
 */
export function reconcileChartTail(
  sources: Pick<ChartResolveSources, "dataProvider">,
  cache: ChartResolveCache,
  now = Date.now(),
): Promise<boolean> {
  if (cache.tailReconcile) return cache.tailReconcile;
  const provider = sources.dataProvider;
  if (!provider || cache.liveTails.size === 0
    || !(provider.getDetailedPriceHistoryWithMetadata || provider.getDetailedPriceHistory)) {
    return Promise.resolve(false);
  }
  const run: Promise<boolean> = Promise.all([...cache.liveTails].map(async ([key, tail]) => {
    const pending = cache.priceHistoryByRequest.get(key);
    const loaded = pending ? await pending.catch(() => {
      // Intentional ignore: resolveChartSpecPass already includes this history failure in the series errors.
      return null;
    }) : null;
    if (!pending || !loaded || loaded.resolution !== tail.resolution) return false;
    const accumulated = cache.accumulatedPriceHistory.get(tail.accumulationKey);
    const latest = latestObservationTime(accumulated?.points ?? loaded.points);
    if (!Number.isFinite(latest) || now - latest > MAX_TAIL_RECONCILE_LAG_MS) return false;
    // The newest loaded bar may still have been forming when it was fetched.
    // Whole-bar starts and whole-minute ends let every chart of this history
    // that asks at the same boundary share one request and one cached window.
    const step = CHART_RESOLUTION_STEP_MS[tail.resolution];
    const start = Math.floor((latest - step) / step) * step;
    const end = Math.ceil(now / 60_000) * 60_000;
    const { symbol, exchange } = tail.source.instrument;
    const context = { ...requestContext(tail.source), ...(tail.historySession ? { historySession: tail.historySession } : {}) };
    const requestKey = JSON.stringify([symbol, exchange ?? "", context.brokerId ?? null,
      context.brokerInstanceId ?? null, context.instrument ?? null, tail.resolution, start, end, tail.historySession ?? null]);
    const shared = tailRequestsInFlight.get(provider) ?? new Map<string, Promise<PriceHistoryResult | null>>();
    tailRequestsInFlight.set(provider, shared);
    let request = shared.get(requestKey);
    if (!request) {
      const fetched = fetchHistoryResult(provider, symbol, exchange ?? "",
        { kind: "detail", start: new Date(start), end: new Date(end), interval: tail.resolution }, context)
        .catch(logFailure("time-series-resolve", "Could not reconcile chart history", null))
        .finally(() => {
          if (shared.get(requestKey) === fetched) shared.delete(requestKey);
        });
      shared.set(requestKey, fetched);
      request = fetched;
    }
    const result = await request;
    if (!result || result.resolution !== loaded.resolution || !!result.extendedHours !== !!loaded.extendedHours
      || priceHistoryAcquisitionIdentity(result) !== priceHistoryAcquisitionIdentity(loaded)) return false;
    const points = result.points.filter((point) => {
      const time = getPricePointTimestamp(point);
      return Number.isFinite(time) && time >= start && Number.isFinite(point.close);
    });
    // A full refetch that landed meanwhile supersedes this window.
    if (points.length === 0 || cache.priceHistoryByRequest.get(key) !== pending) return false;
    const refreshed = mergePriceHistoryWindows(loaded.points, points, tail.resolution);
    if (samePricePoints(refreshed, loaded.points)) return false;
    const acquisition = priceHistoryTailAcquisition(loaded, result);
    // The merged bars are as current as the newer acquisition says.
    cache.priceHistoryByRequest.set(key, Promise.resolve({ ...loaded, points: refreshed,
      session: acquisition.session, sourceKey: acquisition.sourceKey, savedCopyBehind: acquisition.savedCopyBehind }));
    if (accumulated) {
      const accumulatedAcquisition = priceHistoryTailAcquisition(accumulated, result);
      cache.accumulatedPriceHistory.set(tail.accumulationKey, { ...accumulated,
        points: mergePriceHistoryWindows(accumulated.points, points, tail.resolution),
        session: accumulatedAcquisition.session, sourceKey: accumulatedAcquisition.sourceKey });
    }
    cache.revision += 1;
    return true;
  })).then((changes) => changes.some(Boolean)).finally(() => {
    if (cache.tailReconcile === run) cache.tailReconcile = null;
  });
  cache.tailReconcile = run;
  return run;
}
