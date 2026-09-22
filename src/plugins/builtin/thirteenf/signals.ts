import { apiClient } from "../../../api-client";
import type { HoldingAction } from "./types";

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
export interface SignalsBase {
  quarter: string;
  period: string;
  previousPeriod: string;
  warnings: string[];
  asOf: string;
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
  const result = await apiClient.getCloudSec13F("ticker-holdings", { tickers: ticker, offset, limit: 25 }) as TickerHoldings;
  signal?.throwIfAborted();
  return result;
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
