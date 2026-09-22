import { isIntradayResolution, TIME_RANGE_ORDER } from "../../time-series/resolution";
import type { PricePoint } from "../../types/financials";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory, priceHistoryIntervalMs } from "../../utils/price-history";
import { parseHistorySession } from "../history-session";
import { publicListingTarget } from "../../sources/listing-target";
import type { ChartRequest, InstrumentRef } from "../request-types";
import type { QueryEntry } from "../result-types";
import { buildInstrumentKey } from "../selectors";
import { loadingEntry } from "./entries";

const TIME_RANGE_INDEX = new Map(TIME_RANGE_ORDER.map((range, index) => [range, index]));

export function createBaselineChartRequest(instrument: InstrumentRef): ChartRequest {
  return {
    instrument,
    bufferRange: "ALL",
    granularity: "resolution",
    resolution: "1wk",
  };
}

function getChartGranularity(request: ChartRequest): NonNullable<ChartRequest["granularity"]> {
  return request.granularity ?? "range";
}

function getTimeRangeIndex(range: ChartRequest["bufferRange"]): number {
  return TIME_RANGE_INDEX.get(range) ?? 0;
}

function isCurrentHistoryWindow(endDate?: Date): boolean {
  if (!endDate) return true;
  const endMs = endDate.getTime();
  return Number.isFinite(endMs) && Date.now() - endMs < 60 * 60_000;
}

function isIntradayChartRequest(request: ChartRequest, history?: QueryEntry<PricePoint[]>["history"]): boolean {
  const granularity = getChartGranularity(request);
  if (granularity === "detail" && !isCurrentHistoryWindow(request.endDate)) return false;
  if (history?.resolution) return isIntradayResolution(history.resolution);
  if (granularity === "detail") return isCurrentHistoryWindow(request.endDate);
  if (granularity === "resolution") {
    return request.resolution ? isIntradayResolution(request.resolution) : false;
  }
  return request.bufferRange === "1D" || request.bufferRange === "1W" || request.bufferRange === "1M" || request.bufferRange === "3M";
}

export function normalizeFreshChartData(
  points: PricePoint[] | null | undefined, request: ChartRequest, history?: QueryEntry<PricePoint[]>["history"],
): PricePoint[] {
  const normalized = normalizePriceHistory(points ?? []);
  const target = publicListingTarget(request.instrument.symbol, request.instrument.exchange);
  // An opaque fallback remains opaque even when the requested method named a cadence.
  const interval = history ? history.resolution : request.granularity === "resolution" ? request.resolution
    : request.granularity === "detail" ? request.barSize : undefined;
  const session = parseHistorySession(history?.session, { symbol: target.symbol, exchange: target.exchange ?? "",
    interval: interval ?? undefined }) ?? undefined;
  if (
    isIntradayChartRequest(request, history)
    && isPriceHistoryStaleForCurrentWindow(normalized, Date.now(), { exchange: target.exchange,
      intervalMs: interval ? priceHistoryIntervalMs(interval) : undefined, session })
  ) {
    return [];
  }
  return normalized;
}

/** A request can cross a session/bar boundary while its upstream call is pending. */
export function freshChartFallback(entry: QueryEntry<PricePoint[]>, request: ChartRequest): QueryEntry<PricePoint[]> {
  const data = normalizeFreshChartData(entry.lastGoodData, request, entry.history);
  return data.length ? { ...entry, lastGoodData: data }
    : { ...entry, data: null, lastGoodData: null, history: undefined };
}

function isSeedableChartRequest(
  target: ChartRequest,
  candidate: ChartRequest,
): boolean {
  const targetGranularity = getChartGranularity(target);
  const candidateGranularity = getChartGranularity(candidate);
  if (targetGranularity !== candidateGranularity) return false;
  if (targetGranularity === "detail") return false;
  if (targetGranularity === "resolution" && target.resolution !== candidate.resolution) return false;
  if (buildInstrumentKey(target.instrument) !== buildInstrumentKey(candidate.instrument)) return false;
  return getTimeRangeIndex(candidate.bufferRange) <= getTimeRangeIndex(target.bufferRange);
}

interface ChartSeedLookupArgs {
  key: string;
  request: ChartRequest;
  chartRequests: Iterable<[string, ChartRequest]>;
  getEntry: (key: string) => QueryEntry<PricePoint[]>;
  resolveEntryData: (entry: QueryEntry<PricePoint[]>) => PricePoint[] | null;
}

function findChartSeedEntry({
  key,
  request,
  chartRequests,
  getEntry,
  resolveEntryData,
}: ChartSeedLookupArgs): { entry: QueryEntry<PricePoint[]>; data: PricePoint[]; score: number } | null {
  let best: { entry: QueryEntry<PricePoint[]>; data: PricePoint[]; score: number } | null = null;
  for (const [candidateKey, candidateRequest] of chartRequests) {
    if (candidateKey === key) continue;
    if (!isSeedableChartRequest(request, candidateRequest)) continue;
    const entry = getEntry(candidateKey);
    const data = normalizeFreshChartData(resolveEntryData(entry), request, entry.history);
    if (!data?.length) continue;
    const score = getTimeRangeIndex(candidateRequest.bufferRange);
    if (!best || score > best.score) {
      best = { entry, data, score };
    }
  }
  return best;
}

export function createChartLoadingEntry({
  key,
  request,
  current,
  chartRequests,
  getEntry,
  resolveEntryData,
}: ChartSeedLookupArgs & {
  current: QueryEntry<PricePoint[]>;
}): QueryEntry<PricePoint[]> {
  const currentData = normalizeFreshChartData(resolveEntryData(current), request, current.history);
  if (currentData.length) {
    return loadingEntry<PricePoint[]>({
      ...current,
      data: currentData,
      lastGoodData: currentData,
    });
  }

  const seed = findChartSeedEntry({ key, request, chartRequests, getEntry, resolveEntryData });
  if (!seed) {
    return loadingEntry<PricePoint[]>({
      ...current,
      data: null,
      lastGoodData: null,
      history: undefined,
    });
  }

  return loadingEntry({
    ...current,
    data: seed.data,
    lastGoodData: seed.data,
    source: seed.entry.source,
    history: seed.entry.history,
    fetchedAt: seed.entry.fetchedAt,
    staleAt: seed.entry.staleAt,
  });
}
