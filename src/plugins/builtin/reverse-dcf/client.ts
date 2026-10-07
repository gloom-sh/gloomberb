import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";

export interface ReverseDcfSnapshot {
  financials: TickerFinancials | null;
  stale: boolean;
  error: string | null;
  fetchedAt: number;
}

const CANCELLED = "Reverse DCF load was cancelled";

/** The ticker's fundamentals (TTM free cash flow, enterprise value) and annual statements. */
export async function loadReverseDcfInputs(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  marketData?: DataProvider,
): Promise<ReverseDcfSnapshot> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = Date.now();
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  try {
    if (!coordinator) throw new Error("Market data coordinator unavailable");
    const entry = await abortable(coordinator.loadSnapshot(request.instrument, { forceRefresh: request.forceRefresh }), request.signal, CANCELLED);
    const financials = resolveEntryValue(entry);
    return { financials, stale: !!entry.error || !!financials?.fundamentals?.stale || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (financials ? null : "Fundamentals unavailable"), fetchedAt: entry.fetchedAt ?? now };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { financials: null, stale: false, error: errorMessage(error), fetchedAt: now };
  }
}
