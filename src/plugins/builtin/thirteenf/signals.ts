import { apiClient } from "../../../api-client";
import type { PaneFooterSegment } from "../../../components";
import { formatShortDate } from "../../../utils/datetime-format";
import type { HoldingAction } from "./types";
import { thirteenFDueDate } from "./model";
import { movedListing, movedListingNote } from "../../../tickers/listing-fate";
import { logFailure } from "../../../utils/log-failure";

export interface TickerHolderRow {
  id: string;
  cik: string;
  fund: string;
  ticker: string;
  cusip: string;
  issuer: string;
  type: string;
  value: number | null;
  shares: number | null;
  /** Shares at the prior period end when the two reports compare: 0 for a new position, null when unknown. Absent from an older service. */
  previousShares?: number | null;
  weight: number | null;
  previousWeight: number | null;
  weightChange: number | null;
  action: HoldingAction;
}
export interface CrowdingRow {
  id: string;
  ticker: string;
  cusip: string;
  issuer: string;
  type: string;
  holderCount: number;
  newCount: number;
  exitCount: number;
  comparedFunds: number;
  totalValue: number | null;
  weightChange: number | null;
}
interface SignalsBase {
  quarter: string;
  period: string;
  previousPeriod: string;
  fallbackFromPeriod?: string;
  warnings: string[];
  asOf: string;
}

/**
 * "30 Sep holders not indexed yet (13Fs due 16 Nov); showing 30 Jun": why a
 * ticker's holders, or the crowding ranks, are of the quarter before the
 * newest one due. The filings are in: each fund's own 13F shows the newer
 * quarter (`fn 13F ARK`). What is missing is the index of holders by
 * security, which loads a quarter weeks after its deadline.
 */
export function quarterFallbackText(data: Pick<SignalsBase, "period" | "fallbackFromPeriod"> | null | undefined): string | null {
  if (!data?.fallbackFromPeriod || data.fallbackFromPeriod <= data.period) return null;
  const year = data.fallbackFromPeriod.slice(0, 4) !== data.period.slice(0, 4) ? "numeric" : false;
  const date = (period: string) => formatShortDate(period, { utc: true, year });
  return `${date(data.fallbackFromPeriod)} holders not indexed yet (13Fs due ${date(thirteenFDueDate(data.fallbackFromPeriod))}); showing ${date(data.period)}`;
}

export function quarterFallbackFooter(data: Parameters<typeof quarterFallbackText>[0]): PaneFooterSegment[] {
  const text = quarterFallbackText(data);
  return text ? [{ id: "quarter-fallback", parts: [{ text, tone: "warning" }] }] : [];
}
export interface TickerHoldings extends SignalsBase {
  ticker: string;
  rows: TickerHolderRow[];
  holderCount: number;
  newCount: number;
  exitCount: number;
  totalValue: number | null;
  valueScope: string;
  hasMore: boolean;
  nextOffset: number;
}
export interface Crowding extends SignalsBase {
  rows: CrowdingRow[];
  requestedFunds: number;
  sourceFunds: number;
  loadedFunds: number;
}
export async function loadTickerHoldings(ticker: string, offset = 0, signal?: AbortSignal): Promise<TickerHoldings> {
  signal?.throwIfAborted();
  const result = await apiClient.getCloudSec13F("ticker-holdings", { tickers: ticker, offset, limit: 25 }, { signal }) as TickerHoldings;
  signal?.throwIfAborted();
  return result;
}
/**
 * What a ticker's 13F holders are read under: the symbol its company trades
 * as now when it moved (SQ became XYZ), with the note that says so, asked
 * before any holders request. The holders source maps a symbol to its
 * security, and an old one maps to nothing: it gave up after 20 s.
 */
export async function holdersTicker(ticker: string, marketData: Parameters<typeof movedListing>[1] | null | undefined): Promise<{ ticker: string; note?: string }> {
  const change = marketData ? await movedListing({ symbol: ticker }, marketData)
    .catch(logFailure("thirteenf-signals", "Read whether a 13F ticker moved failed", null)) : null;
  return change ? { ticker: change.tradesAs, note: movedListingNote(change) } : { ticker };
}
export async function loadCrowding(signal?: AbortSignal): Promise<Crowding> {
  signal?.throwIfAborted();
  const result = await apiClient.getCloudSec13F("crowding", { limit: 25 }) as Crowding;
  signal?.throwIfAborted();
  return result;
}
export function appendTickerHoldings(current: TickerHoldings, page: TickerHoldings): TickerHoldings {
  if (current.ticker !== page.ticker || current.period !== page.period) return page;
  const rows = [...new Map([...current.rows, ...page.rows].map(row => [row.id, row])).values()];
  return { ...page, rows, warnings: [...new Set([...current.warnings, ...page.warnings])], totalValue: rows.filter(row => row.action !== "exit").reduce<number | null>((total, row) => total != null && row.value != null ? total + row.value : null, 0), valueScope: "loaded funds" };
}
