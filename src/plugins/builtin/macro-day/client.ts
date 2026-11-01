import { apiClient, type CloudMacroReleaseDaysPayload } from "../../../api-client";
import { createPluginCache } from "../../../data/plugin-cache";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import { tickerHasListingSuffix } from "../../../sources/listing-symbols";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { parsePublicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { loadEarningsHistory } from "../earnings/client";
import type { MacroDayEarningsReport } from "./model";
import { bundledMacroReleases, mergeMacroReleases, type MacroReleaseList } from "./releases";

export const macroReleaseCache = createPluginCache<CloudMacroReleaseDaysPayload>({
  kind: "macro-release-days", source: "gloom-cloud", schemaVersion: 1,
  // A release lands at 8:30 or 14:00 ET; the last list read is kept for a terminal that goes offline.
  policy: { staleMs: 30 * 60_000, expireMs: 90 * 86_400_000 },
});

/**
 * The bundled list, extended by the server's when it reaches further. A
 * failed read keeps the last list read; with none, the bundled list alone.
 */
export async function loadMacroReleases(options: { force?: boolean } = {},
  read: () => Promise<CloudMacroReleaseDaysPayload> = () => apiClient.getCloudMacroReleaseDays()): Promise<MacroReleaseList> {
  const floor = bundledMacroReleases();
  try {
    const result = await macroReleaseCache.load("release-days", read, { force: options.force });
    return mergeMacroReleases(floor, result.data);
  } catch {
    return floor;
  }
}

export interface MacroDayHistory {
  history: PricePoint[];
  stale: boolean;
  error: string | null;
  fetchedAt: number;
}

const CANCELLED = "Macro-day history load was cancelled";
const US_LISTINGS_ONLY = "Macro-day moves are for US listings.";

/**
 * A listing whose venue sits outside New York trades US releases on a different clock.
 * A bare symbol such as 7203.T carries no exchange, so its venue suffix names it,
 * and a listing key such as SAP:XETR names it before the ticker record has loaded.
 */
function isNonUsVenue(instrument: InstrumentRef): boolean {
  if (tickerHasListingSuffix(instrument.symbol)) return true;
  const zone = resolveExchangeTimeZone(instrument.exchange || parsePublicTickerKey(instrument.symbol).exchange);
  return !!zone && zone !== "America/New_York";
}

/** Five years of daily closes, the longest daily history served; the lookback is cut in the model. */
export async function loadMacroDayHistory(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  marketData?: DataProvider,
): Promise<MacroDayHistory> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = Date.now();
  if (isNonUsVenue(request.instrument)) return { history: [], stale: false, error: US_LISTINGS_ONLY, fetchedAt: now };
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  try {
    if (!coordinator) throw new Error("Market data coordinator unavailable");
    const entry = await abortable(coordinator.loadChart({ instrument: request.instrument, bufferRange: "5Y",
      granularity: "resolution", resolution: "1d" }, { forceRefresh: request.forceRefresh }), request.signal, CANCELLED);
    const history = resolveEntryValue(entry) ?? [];
    return { history, stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (history.length ? null : "Daily price history unavailable"), fetchedAt: entry.fetchedAt ?? now };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { history: [], stale: false, error: errorMessage(error), fetchedAt: now };
  }
}

/** A FRED series read as closes: its daily values, and whether a value is a rate, whose moves read in bp. */
export interface MacroDaySeriesHistory extends MacroDayHistory {
  /** The series is in percent (a yield or a spread such as T10Y2Y): a move is the change in its level. */
  rate: boolean;
  /** FRED's title for it, "10-Year Treasury Constant Maturity Minus 2-Year Treasury Constant Maturity". */
  title: string | null;
}

/** The five years of daily values a release-day study reads, as the price history is. */
const SERIES_LOOKBACK_DAYS = 5 * 366;

/**
 * A FRED series (`FRED:T10Y2Y`) as the study's closes: each dated value, with
 * blank days (holidays FRED lists as no value) left out. A rate or spread in
 * percent moves by its level, read in basis points; any other series by its
 * return. Never rejects but on cancel.
 */
export async function loadMacroDaySeriesHistory(
  request: { seriesId: string; signal?: AbortSignal },
  client: Pick<typeof apiClient, "getCloudFredSeries"> = apiClient,
  now = Date.now(),
): Promise<MacroDaySeriesHistory> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const startDate = new Date(now - SERIES_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  try {
    const payload = await abortable(client.getCloudFredSeries(request.seriesId, { startDate, sortOrder: "asc" },
      request.signal ? { signal: request.signal } : {}), request.signal, CANCELLED);
    const history = payload.observations
      .filter((point) => typeof point.value === "number" && Number.isFinite(point.value) && /^\d{4}-\d{2}-\d{2}$/.test(point.date))
      .map((point) => ({ date: new Date(`${point.date}T00:00:00Z`), close: point.value! }))
      .sort((left, right) => left.date.getTime() - right.date.getTime());
    const fetchedAt = payload.fetchedAt ? Date.parse(payload.fetchedAt) : now;
    return { history, stale: payload.stale === true, error: history.length ? null : `No values for FRED:${request.seriesId}`,
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : now,
      rate: /^percent\b/i.test(payload.info?.units?.trim() ?? ""), title: payload.info?.title?.trim() || null };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { history: [], stale: false, error: errorMessage(error), fetchedAt: now, rate: false, title: null };
  }
}

export interface MacroDayEarnings {
  reports: MacroDayEarningsReport[];
  stale: boolean;
  /** Why the reports are missing; the study then runs without the earnings marker. */
  error: string | null;
}

/** The earnings history's own depth: the oldest report that can matter is five years back, about twenty quarters. */
const EARNINGS_REPORT_LIMIT = 24;

/**
 * The ticker's own earnings reports, from the history `ERN` shows. Never
 * rejects but on cancel: a listing outside the US or without reports has none,
 * and a failed read leaves the study as it was, with the reason in `error`.
 */
export async function loadMacroDayEarnings(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  load: typeof loadEarningsHistory = loadEarningsHistory,
): Promise<MacroDayEarnings> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  if (isNonUsVenue(request.instrument)) return { reports: [], stale: false, error: null };
  try {
    // Earnings are keyed by the bare US symbol; a listing key ("CRWV:XNAS") drops its exchange.
    const symbol = parsePublicTickerKey(request.instrument.symbol.trim()).symbol.toUpperCase();
    const resource = await abortable(load(symbol, request.forceRefresh, EARNINGS_REPORT_LIMIT), request.signal, CANCELLED);
    return { reports: resource.payload.reports.map((report) => ({ date: report.date, timing: report.timing, reactionSession: report.realized?.afterSession ?? null })),
      stale: resource.stale, error: null };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { reports: [], stale: false, error: errorMessage(error) };
  }
}

/** What the pane footer and the report notes say when the earnings marker could not be applied. */
export function macroDayEarningsNotice(earnings: MacroDayEarnings): string | null {
  return earnings.error ? `Earnings dates unavailable (${earnings.error}); release days on the company's own report are not marked.` : null;
}
