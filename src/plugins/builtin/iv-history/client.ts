import { apiClient } from "../../../api-client";
import { listingAbroadVenue, usListingSymbol } from "../../../utils/sec";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { realizedVolatility, realizedVolatilityCadenceIssue } from "../shared/volatility";
import { NO_FATE, type ListingFate } from "../../../tickers/listing-fate";

export type IvMethod = "quote-mid" | "trade-close";
export type IvCoverageStatus = "ready" | "backfilling" | "queued" | "unavailable";
export interface IvPoint {
  sessionDate: string;
  method: IvMethod;
  capturedAt: string;
  spot: number | null;
  iv7: number | null;
  iv30: number | null;
  iv60: number | null;
  iv90: number | null;
  iv180: number | null;
  iv365: number | null;
  /**
   * 30-day 25-delta put and call IV, on quote captures only. Optional: a
   * server that leaves them out has no skew history to give.
   */
  put25_30?: number | null;
  call25_30?: number | null;
}
export interface IvStats {
  value: number;
  date: string;
  method: IvMethod;
  rank: number | null;
  percentile: number | null;
  low: number | null;
  high: number | null;
  samples: number;
  windowStart: string | null;
  /** Prior sessions the rank needs: 120, or 60 for IV1Y. Absent from older servers. */
  minSamples?: number;
  /** Why rank or percentile is empty, when one is. */
  rankNote?: string | null;
}
interface IvReading {
  date: string;
  method: IvMethod;
  capturedAt: string;
  spot: number | null;
  iv7: number | null;
  iv30: number | null;
  iv60: number | null;
  iv90: number | null;
  iv180: number | null;
  iv365: number | null;
}
export interface IvHistoryPayload {
  version: 1;
  symbol: string;
  asOf: string;
  status: IvCoverageStatus;
  coverage: {
    source: "seed" | "demand"; addedAt: string; backfilledThrough: string | null; since: string | null;
    /** First trade close with a one-year reading; the 1Y series starts later and is sparser. */
    iv365Since?: string | null;
  } | null;
  stats: { iv30: IvStats | null; iv90: IvStats | null; iv365?: IvStats | null };
  latest: IvReading | null;
  series: IvPoint[];
  warnings: string[];
}
export interface IvScreenRow {
  symbol: string;
  /** Has readings, or none yet. All an older server says; `coverageStatus` is exact. */
  status: "ready" | "queued";
  /** Where the symbol's history stands, as in `IvHistoryPayload.status`. Absent from older servers. */
  coverageStatus?: IvCoverageStatus;
  /** When the symbol was queued and how far its backfill has got; null when it is not covered. */
  coverage?: { source: "seed" | "demand"; addedAt: string; backfilledThrough: string | null } | null;
  /** Why it is not covered yet, such as demand coverage being full. */
  warnings?: string[];
  iv30: IvStats | null;
  iv90: IvStats | null;
  iv365?: IvStats | null;
  iv365Since?: string | null;
  latest: IvReading | null;
  skew: { date: string; put25: number; call25: number; skew: number } | null;
}
export interface IvScreenPayload { version: 1; asOf: string; rows: IvScreenRow[] }
export interface StoredSurfacePayload {
  version: 1;
  symbol: string;
  sessionDate: string;
  capturedAt: string;
  spot: number;
  surface: Record<string, unknown>;
}

export type ImpliedVolatilityApi = Pick<typeof apiClient, "impliedVolatility">;
const query = (params: Record<string, string>) => new URLSearchParams(params).toString();
/** Stored IV is keyed by the bare US symbol; a listing key ("SPY:ARCX") drops its exchange. */
/** A US listing's symbol; a listing abroad is refused, since its bare symbol's options are another company's. */
export const ivSymbol = (symbol: string) => usListingSymbol(symbol, "Implied volatility");

export function loadIvHistory(symbol: string, options: { signal?: AbortSignal; days?: number } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<IvHistoryPayload>(`history?${query({ symbol: ivSymbol(symbol), days: String(options.days ?? 1100) })}`,
    { signal: options.signal });
}
/** A listing abroad has no row: its bare symbol's options are another company's. */
export function loadIvScreen(symbols: readonly string[], options: { signal?: AbortSignal } = {}, api: ImpliedVolatilityApi = apiClient) {
  const us = symbols.filter((symbol) => listingAbroadVenue(symbol) == null).map(ivSymbol);
  return api.impliedVolatility<IvScreenPayload>(`screen?${query({ symbols: us.join(",") })}`, { signal: options.signal });
}
export function loadSurfaceDates(symbol: string, options: { signal?: AbortSignal } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<{ version: 1; symbol: string; dates: string[] }>(`surface-dates?${query({ symbol: ivSymbol(symbol) })}`,
    { signal: options.signal });
}
export function loadStoredSurface(symbol: string, date: string, options: { signal?: AbortSignal } = {}, api: ImpliedVolatilityApi = apiClient) {
  return api.impliedVolatility<StoredSurfacePayload>(`surface?${query({ symbol: ivSymbol(symbol), date })}`, { signal: options.signal });
}

export interface HvDependencies {
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
  /** What became of a symbol (`MarketDataCoordinator.loadListingFate`). */
  loadFate(instrument: InstrumentRef): Promise<ListingFate>;
}
export function createHvDependencies(marketData?: DataProvider): HvDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  return { loadChart: (request, options) => coordinator ? coordinator.loadChart(request, options)
    : Promise.reject(new Error("Market data coordinator unavailable")),
    loadFate: (instrument) => coordinator ? coordinator.loadListingFate(instrument) : Promise.resolve(NO_FATE) };
}

/** Screen rows with no reading whose symbol's fate is looked up; a long list of them is a backfill, not a lookup. */
const MAX_FATE_LOOKUPS = 10;

/**
 * HV for a screen's symbols (`loadRealizedVolatilities`), started at once,
 * and what became of the ones its rows have no reading for, at most
 * MAX_FATE_LOOKUPS of them, looked up as the rows arrive: TWTR stopped
 * trading, FB is a fund now, HFC became DINO. A symbol whose company moved,
 * with nothing new listed under it, has no figures of its own: whatever its
 * bars give is another security's, so it has no HV. Rows that fail to load
 * look nothing up.
 */
export async function loadScreenVolatilities(
  instruments: readonly InstrumentRef[], rows: Promise<readonly IvScreenRow[]>, window: number,
  options: { signal?: AbortSignal; onValue?: (symbol: string, value: number | null) => void; onFates?: (fates: ReadonlyMap<string, ListingFate>) => void } = {},
  dependencies: HvDependencies = createHvDependencies(),
): Promise<{ hv: Map<string, number | null>; fates: Map<string, ListingFate> }> {
  const moved = new Set<string>();
  const onValue = options.onValue && ((symbol: string, value: number | null) => { if (!moved.has(symbol)) options.onValue!(symbol, value); });
  const [hv, fates] = await Promise.all([
    loadRealizedVolatilities(instruments, window, { ...options, onValue }, dependencies),
    rows.then(async (screened) => {
      const unread = new Set(screened.filter((row) => row.latest?.iv30 == null && row.latest?.date == null)
        .slice(0, MAX_FATE_LOOKUPS).map((row) => row.symbol));
      const fates = new Map(await Promise.all(instruments.filter((instrument) => unread.has(instrument.symbol)).map(async (instrument) =>
        [instrument.symbol, await dependencies.loadFate(instrument).catch(() => NO_FATE)] as const)));
      for (const [symbol, fate] of fates) if (fate.moved) moved.add(symbol);
      if (!options.signal?.aborted) options.onFates?.(fates);
      return fates;
    }, () => new Map<string, ListingFate>()),
  ]);
  for (const symbol of moved) hv.set(symbol, null);
  return { hv, fates };
}

/** Close-to-close HV over one window for each symbol from one year of daily closes, four at a time. */
async function loadRealizedVolatilities(
  instruments: readonly InstrumentRef[], window: number, options: { signal?: AbortSignal; onValue?: (symbol: string, value: number | null) => void } = {},
  dependencies: HvDependencies = createHvDependencies(),
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  let next = 0;
  const worker = async () => {
    while (next < instruments.length && !options.signal?.aborted) {
      const instrument = instruments[next++]!;
      let value: number | null = null;
      try {
        const entry = await dependencies.loadChart({ instrument, bufferRange: "1Y", granularity: "resolution", resolution: "1d" });
        const history = resolveEntryValue(entry) ?? [];
        // A provider that fell back to weekly or intraday bars would misstate daily HV.
        value = realizedVolatilityCadenceIssue(history) ? null : realizedVolatility(history, window);
      } catch { value = null; }
      result.set(instrument.symbol, value);
      options.onValue?.(instrument.symbol, value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, instruments.length) }, worker));
  return result;
}
