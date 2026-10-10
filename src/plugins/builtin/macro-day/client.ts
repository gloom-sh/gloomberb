import { apiClient, type CloudMacroReleaseDaysPayload } from "../../../api-client";
import { createPluginCache } from "../../../data/plugin-cache";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import { tickerHasListingSuffix } from "../../../sources/listing-symbols";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { resolveExchangeTimeZone } from "../../../utils/exchanges";
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
 * A bare symbol such as 7203.T carries no exchange, so its venue suffix names it.
 */
function isNonUsVenue(instrument: InstrumentRef): boolean {
  if (tickerHasListingSuffix(instrument.symbol)) return true;
  const zone = resolveExchangeTimeZone(instrument.exchange);
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
