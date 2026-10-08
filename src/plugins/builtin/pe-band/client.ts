import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { ManualChartResolution } from "../../../time-series/resolution";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, TickerFinancials } from "../../../types/financials";
import { abortable, abortError, settleWithin } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { isUsListingExchange } from "../../../utils/exchanges";
import { fetchEarningsHistory } from "../earnings/client";
import { reportDatesFrom, type ReportDate } from "./report-dates";

export interface PeBandInputs {
  financials: TickerFinancials | null;
  history: PricePoint[];
  stale: boolean;
  /** Fundamentals failed: there is no EPS to price. */
  error: string | null;
  /** Price history failed: the pane can still list EPS, but draws nothing. */
  historyError: string | null;
  /** Report dates for US listings; empty for the rest and when the earnings history is unavailable. */
  reports: ReportDate[];
  fetchedAt: number;
}

const CANCELLED = "P/E band load was cancelled";
/** Weekly bars: daily history is only served to 5Y, and the band covers every year of statements on record. */
const PE_BAND_HISTORY_RESOLUTION: ManualChartResolution = "1wk";
/** The most reports the server returns for one company: about ten years of quarters. */
const REPORT_LIMIT = 40;
/** Report dates only refine the figures' dates, so the pane does not wait longer than this for them. */
const REPORT_DEADLINE_MS = 8_000;

type ReportClient = Pick<typeof apiClient, "getCloudEarningsHistory">;

/** Never rejects: a listing without reports, an outage or a refused session leaves the figures as they are. */
function loadReportDates(symbol: string, client: ReportClient): Promise<ReportDate[]> {
  return settleWithin(fetchEarningsHistory(symbol, client, REPORT_LIMIT), REPORT_DEADLINE_MS)
    .then((payload) => (payload ? reportDatesFrom(payload) : []));
}

/**
 * Statements with the extended SEC history where the listing has one (the
 * snapshot alone carries about six quarters), and every week of closes. US
 * listings also get the company's report dates, which date the figures that
 * have no publication date of their own.
 */
export async function loadPeBandInputs(
  request: { instrument: InstrumentRef; signal?: AbortSignal; forceRefresh?: boolean },
  marketData: DataProvider,
  coordinator: MarketDataCoordinator = getSharedMarketDataCoordinator() ?? new MarketDataCoordinator(marketData),
  cloud: ReportClient = apiClient,
): Promise<PeBandInputs> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = Date.now();
  const { instrument } = request;
  // Asked alongside the statements when the instrument names a US exchange; otherwise once the quote has said where it lists.
  const early = isUsListingExchange(instrument.exchange) ? loadReportDates(instrument.symbol, cloud) : null;
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
  const quote = value?.quote;
  const reports = await abortable(early ?? (isUsListingExchange(quote?.listingExchangeName ?? quote?.exchangeName ?? quote?.fullExchangeName)
    ? loadReportDates(instrument.symbol, cloud) : Promise.resolve([])), request.signal, CANCELLED);
  return {
    financials: value,
    history,
    reports,
    stale: !!value?.fundamentals?.stale || !!entry?.error || (entry?.staleAt != null && entry.staleAt <= now),
    error: financials.status === "rejected" ? errorMessage(financials.reason) : null,
    historyError: chart.status === "rejected" ? errorMessage(chart.reason)
      : entry?.error?.message ?? (history.length ? null : "Weekly price history unavailable"),
    fetchedAt: entry?.fetchedAt ?? now,
  };
}
