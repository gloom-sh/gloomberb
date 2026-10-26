import { apiClient } from "../../../api-client";
import { listingAbroadVenue, usListingSymbol } from "../../../utils/sec";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { realizedVolatilityCadenceIssue, rollingRealizedVolatility } from "../shared/volatility";
import { NO_FATE, type ListingFate } from "../../../tickers/listing-fate";

export type IvMethod = "quote-mid" | "trade-close";
/**
 * Which prices a trade-close reading was solved from: each option's closing
 * print, kept because it sat inside the closing two-sided quote (`print`), the
 * quote midpoint, used where a print sat outside it (`mid`), or both
 * (`mixed`). Absent when no closing quote was stored to check the prints
 * against, as for most history before the checks began.
 */
export type IvCloseBasis = "print" | "mid" | "mixed";
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
  /** Prices a trade close was solved from; see `IvCloseBasis`. Absent from older servers. */
  basis?: IvCloseBasis | null;
}
export interface IvStats {
  value: number;
  date: string;
  method: IvMethod;
  basis?: IvCloseBasis | null;
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
  basis?: IvCloseBasis | null;
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
/** Why a name IV history covers has no rank yet, by where its history stands. */
const IV_COVERAGE_REASONS: Partial<Record<IvCoverageStatus, string>> = {
  queued: "IV history queued, try again in a few minutes",
  backfilling: "IV history still loading",
  unavailable: "no options history",
};

/**
 * Why a screened name has no IV rank, in words for the reader: the server's
 * note for a history too short to rank, or where its history stands. Null when
 * there is nothing true to add, as for a name demand coverage could not take
 * (the row carries the server's queue wording as a warning): none of its
 * history is being collected, so no reason and no promise of one later.
 */
export function ivRankReason(row: IvScreenRow | undefined): string | null {
  if (!row) return "no IV history";
  if (row.iv30?.rankNote) return row.iv30.rankNote;
  if (row.warnings?.length) return null;
  return IV_COVERAGE_REASONS[row.coverageStatus ?? row.status] ?? null;
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
 * A symbol's realized volatility over one window: the newest, and after every
 * session's close, so a reading is divided by the HV of its own date and not
 * of today.
 */
export interface ScreenHv {
  /** HV over the newest window of closes. */
  value: number | null;
  /** Date of the newest daily bar: the newest session the symbol's prices reach. */
  date: string | null;
  /** HV after each session's close, oldest first; sessions without a full window are left out. */
  series: ReadonlyArray<readonly [date: string, value: number]>;
}

const barDay = (value: Date) => new Date(value).toISOString().slice(0, 10);

/** `ScreenHv` from daily closes; a provider that fell back to weekly or intraday bars would misstate daily HV, so it has none. */
export function screenHv(history: readonly PricePoint[], window: number): ScreenHv {
  if (realizedVolatilityCadenceIssue(history)) return { value: null, date: null, series: [] };
  const rolling = rollingRealizedVolatility(history, { windows: [window] });
  const series = rolling.flatMap((point) => {
    const value = point.values[window];
    return value == null ? [] : [[barDay(point.date), value] as const];
  });
  const newest = history.reduce<string | null>((latest, point) => {
    const date = barDay(point.date);
    return latest == null || date > latest ? date : latest;
  }, null);
  return { value: rolling.at(-1)?.values[window] ?? null, date: newest, series };
}

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
  options: { signal?: AbortSignal; onValue?: (symbol: string, value: ScreenHv | null) => void; onFates?: (fates: ReadonlyMap<string, ListingFate>) => void } = {},
  dependencies: HvDependencies = createHvDependencies(),
): Promise<{ hv: Map<string, ScreenHv | null>; fates: Map<string, ListingFate> }> {
  const moved = new Set<string>();
  const onValue = options.onValue && ((symbol: string, value: ScreenHv | null) => { if (!moved.has(symbol)) options.onValue!(symbol, value); });
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
  instruments: readonly InstrumentRef[], window: number, options: { signal?: AbortSignal; onValue?: (symbol: string, value: ScreenHv | null) => void } = {},
  dependencies: HvDependencies = createHvDependencies(),
): Promise<Map<string, ScreenHv | null>> {
  const result = new Map<string, ScreenHv | null>();
  let next = 0;
  const worker = async () => {
    while (next < instruments.length && !options.signal?.aborted) {
      const instrument = instruments[next++]!;
      let value: ScreenHv | null = null;
      try {
        const entry = await dependencies.loadChart({ instrument, bufferRange: "1Y", granularity: "resolution", resolution: "1d" });
        value = screenHv(resolveEntryValue(entry) ?? [], window);
      } catch { value = null; }
      result.set(instrument.symbol, value);
      options.onValue?.(instrument.symbol, value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, instruments.length) }, worker));
  return result;
}
