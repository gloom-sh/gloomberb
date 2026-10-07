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

const CANCELLED = "Seasonality history load was cancelled";
/** The cadence the pane reads, and so the cadence a screenshot captures. */
export const SEASONALITY_HISTORY_RESOLUTION: ManualChartResolution = "1mo";

/**
 * Every month on record: the lookback is cut in the model, so changing it never
 * refetches. Monthly bars, because daily history is only served to 5Y where
 * provider support is not known yet, and a longer daily request comes back as
 * Monday-stamped weeks that file a week's close under the wrong month.
 */
export async function loadSeasonalityHistory(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  marketData?: DataProvider,
): Promise<SeasonalityHistory> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = Date.now();
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  try {
    if (!coordinator) throw new Error("Market data coordinator unavailable");
    const entry = await abortable(coordinator.loadChart({ instrument: request.instrument, bufferRange: "ALL",
      granularity: "resolution", resolution: SEASONALITY_HISTORY_RESOLUTION }, { forceRefresh: request.forceRefresh }), request.signal, CANCELLED);
    const history = resolveEntryValue(entry) ?? [];
    return { history, stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (history.length ? null : "Monthly price history unavailable"), fetchedAt: entry.fetchedAt ?? now };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { history: [], stale: false, error: errorMessage(error), fetchedAt: now };
  }
}
