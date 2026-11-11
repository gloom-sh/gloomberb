import { apiClient } from "../../../api-client";
import { unavailableText } from "../../../components/ui/status";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { FxHistoryClient } from "../../../market-data/fx-closes";
import { withBalanceSheetRate } from "../../../market-data/quotes/balance-sheet-rate";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerFinancials } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { loadExchangeResults, RESULTS_ANNOUNCEMENT_LIMIT, type ExchangeAnnouncementsReader, type ExchangeResults } from "../../../utils/exchange-results";
import { latestReportedPeriod } from "../../../utils/latest-financial-period";

export interface ReverseDcfSnapshot {
  financials: TickerFinancials | null;
  /** An HKEX company's results announcements: what dates the EV's balance sheet and where a missing FCF is published. */
  exchangeResults: ExchangeResults | null;
  stale: boolean;
  error: string | null;
  fetchedAt: number;
}

const CANCELLED = "Reverse DCF load was cancelled";

/** Where the inputs beyond the snapshot come from: Gloom Cloud in the app, fakes in tests. */
export interface ReverseDcfSources {
  fxHistory?: FxHistoryClient;
  exchangeAnnouncements?: ExchangeAnnouncementsReader;
}

const cloudSources: Required<ReverseDcfSources> = {
  fxHistory: apiClient,
  exchangeAnnouncements: (listing) => apiClient.getCloudExchangeAnnouncements({ ...listing, limit: RESULTS_ANNOUNCEMENT_LIMIT, kind: "results" }),
};

/**
 * The ticker's fundamentals (TTM free cash flow, enterprise value) and statements, with the close a balance sheet in
 * another currency converts at, and an HKEX company's results announcements; each of those two within a few seconds.
 */
export async function loadReverseDcfInputs(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  marketData?: DataProvider,
  sources: ReverseDcfSources = cloudSources,
): Promise<ReverseDcfSnapshot> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = Date.now();
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  try {
    if (!coordinator) throw new Error("Market data coordinator unavailable");
    const entry = await abortable(coordinator.loadSnapshot(request.instrument, { forceRefresh: request.forceRefresh }), request.signal, CANCELLED);
    const loaded = resolveEntryValue(entry);
    const latestPeriod = loaded ? latestReportedPeriod(loaded) : null;
    const [financials, exchangeResults] = await abortable(Promise.all([
      loaded && sources.fxHistory ? withBalanceSheetRate(loaded, sources.fxHistory) : loaded,
      loadExchangeResults(sources.exchangeAnnouncements, { symbol: request.instrument.symbol, exchange: request.instrument.exchange }, latestPeriod),
    ]), request.signal, CANCELLED);
    return { financials, exchangeResults, stale: !!entry.error || !!financials?.fundamentals?.stale || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (financials ? null : unavailableText("Fundamentals")), fetchedAt: entry.fetchedAt ?? now };
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { financials: null, exchangeResults: null, stale: false, error: errorMessage(error), fetchedAt: now };
  }
}
