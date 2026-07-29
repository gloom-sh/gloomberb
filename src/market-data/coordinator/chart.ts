import { isIntradayResolution, TIME_RANGE_ORDER } from "../../time-series/resolution";
import type { PricePoint } from "../../types/financials";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory } from "../../utils/price-history";
import type { ChartRequest, InstrumentRef } from "../request-types";
import type { QueryEntry } from "../result-types";
import { buildInstrumentKey } from "../selectors";
import { loadingEntry } from "./entries";

const TIME_RANGE_INDEX = new Map(TIME_RANGE_ORDER.map((range, index) => [range, index]));

export function createBaselineChartRequest(instrument: InstrumentRef): ChartRequest {
  return {
    instrument,
    bufferRange: "5Y",
    granularity: "range",
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

function isIntradayChartRequest(request: ChartRequest): boolean {
  const granularity = getChartGranularity(request);
  if (granularity === "detail") return isCurrentHistoryWindow(request.endDate);
  if (granularity === "resolution") {
    return request.resolution ? isIntradayResolution(request.resolution) : false;
  }
  return request.bufferRange === "1D" || request.bufferRange === "1W" || request.bufferRange === "1M" || request.bufferRange === "3M";
}

export function normalizeFreshChartData(points: PricePoint[] | null | undefined, request: ChartRequest): PricePoint[] {
  const normalized = normalizePriceHistory(points ?? []);
  if (
    isIntradayChartRequest(request)
    && isPriceHistoryStaleForCurrentWindow(normalized, Date.now(), { exchange: request.instrument.exchange })
  ) {
    return [];
  }
  return normalized;
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
    const data = resolveEntryData(entry);
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
  const currentData = normalizeFreshChartData(resolveEntryData(current), request);
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
    });
  }

  const seedData = normalizeFreshChartData(seed.data, request);
  if (!seedData.length) {
    return loadingEntry<PricePoint[]>({
      ...current,
      data: null,
      lastGoodData: null,
    });
  }

  return loadingEntry({
    ...current,
    data: seedData,
    lastGoodData: seedData,
    source: seed.entry.source,
    fetchedAt: seed.entry.fetchedAt,
    staleAt: seed.entry.staleAt,
  });
}
