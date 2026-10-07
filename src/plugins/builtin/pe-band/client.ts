import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { ManualChartResolution } from "../../../time-series/resolution";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, TickerFinancials } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";

export interface PeBandInputs {
  financials: TickerFinancials | null;
  history: PricePoint[];
  stale: boolean;
  /** Fundamentals failed: there is no EPS to price. */
  error: string | null;
  /** Price history failed: the pane can still list EPS, but draws nothing. */
  historyError: string | null;
  fetchedAt: number;
}

const CANCELLED = "P/E band load was cancelled";
/** Weekly bars: daily history is only served to 5Y, and the band covers every year of statements on record. */
const PE_BAND_HISTORY_RESOLUTION: ManualChartResolution = "1wk";

/**
 * Statements with the extended SEC history where the listing has one (the
 * snapshot alone carries about six quarters), and every week of closes.
 */
export async function loadPeBandInputs(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  marketData: DataProvider,
  coordinator: MarketDataCoordinator = getSharedMarketDataCoordinator() ?? new MarketDataCoordinator(marketData),
): Promise<PeBandInputs> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = Date.now();
  const { instrument } = request;
  const [financials, chart] = await abortable(Promise.allSettled([
    marketData.getTickerFinancials(instrument.symbol, instrument.exchange ?? "", {
      brokerId: instrument.instrument?.brokerId ?? instrument.brokerId,
      brokerInstanceId: instrument.instrument?.brokerInstanceId ?? instrument.brokerInstanceId,
      instrument: instrument.instrument ?? null,
      statementHistory: "extended",
      ...(request.forceRefresh ? { cacheMode: "refresh" as const } : {}),
    }),
    coordinator.loadChart({ instrument, bufferRange: "ALL", granularity: "resolution", resolution: PE_BAND_HISTORY_RESOLUTION },
      { forceRefresh: request.forceRefresh }),
  ]), request.signal, CANCELLED).catch((error: unknown) => {
    throw request.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? abortError(CANCELLED) : error;
  });
  const value = financials.status === "fulfilled" ? financials.value : null;
  const entry = chart.status === "fulfilled" ? chart.value : null;
  const history = entry ? resolveEntryValue(entry) ?? [] : [];
  return {
    financials: value,
    history,
    stale: !!value?.fundamentals?.stale || !!entry?.error || (entry?.staleAt != null && entry.staleAt <= now),
    error: financials.status === "rejected" ? errorMessage(financials.reason) : null,
    historyError: chart.status === "rejected" ? errorMessage(chart.reason)
      : entry?.error?.message ?? (history.length ? null : "Weekly price history unavailable"),
    fetchedAt: entry?.fetchedAt ?? now,
  };
}
