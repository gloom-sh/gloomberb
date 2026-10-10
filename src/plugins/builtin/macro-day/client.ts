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
