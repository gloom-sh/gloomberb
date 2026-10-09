import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { ManualChartResolution } from "../../../time-series/resolution";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";

export interface SeasonalityHistory {
  history: PricePoint[];
  stale: boolean;
  error: string | null;
  fetchedAt: number;
}

/** Monthly closes for the Returns and Overlay tabs, daily closes for Weekdays. */
export type SeasonalityCadence = "monthly" | "daily";

const CANCELLED = "Seasonality history load was cancelled";
/** The cadence each tab reads, and so the cadence a screenshot of it captures. */
export const SEASONALITY_HISTORY_RESOLUTION: Record<SeasonalityCadence, ManualChartResolution> = { monthly: "1mo", daily: "1d" };
/** Daily history is served to five years; a longer request can come back as weekly bars. */
const BUFFER_RANGE = { monthly: "ALL", daily: "5Y" } as const;

/**
 * Every month on record: the lookback is cut in the model, so changing it never
 * refetches. Monthly bars, because daily history is only served to 5Y where
 * provider support is not known yet, and a longer daily request comes back as
 * Monday-stamped weeks that file a week's close under the wrong month. The
 * Weekdays tab needs sessions, so it reads those five years of daily bars.
 */
export async function loadSeasonalityHistory(
  request: { instrument: InstrumentRef; cadence?: SeasonalityCadence; signal?: AbortSignal; forceRefresh?: boolean },
  marketData?: DataProvider,
): Promise<SeasonalityHistory> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const cadence = request.cadence ?? "monthly";
  const now = Date.now();
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  try {
    if (!coordinator) throw new Error("Market data coordinator unavailable");
    const entry = await abortable(coordinator.loadChart({ instrument: request.instrument, bufferRange: BUFFER_RANGE[cadence],
      granularity: "resolution", resolution: SEASONALITY_HISTORY_RESOLUTION[cadence] }, { forceRefresh: request.forceRefresh }), request.signal, CANCELLED);
    const history = resolveEntryValue(entry) ?? [];
    return { history, stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (history.length ? null : `${cadence === "daily" ? "Daily" : "Monthly"} price history unavailable`),
      fetchedAt: entry.fetchedAt ?? now };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { history: [], stale: false, error: errorMessage(error), fetchedAt: now };
  }
}
