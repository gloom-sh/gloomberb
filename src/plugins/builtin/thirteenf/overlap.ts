import { buildFundHoldingRows } from "./model";
import type { FundDetailData } from "./types";

export interface FundOverlapRow {
  id: string;
  ticker: string;
  issuer: string;
  type: string;
  weight: number | null;
  comparedWeight: number | null;
}

/** Quarter ends a fund can be compared at: its latest report, and the previous one when it loaded. */
function comparablePeriods(data: FundDetailData): string[] {
  return [
    data.latestForm?.periodOfReport,
    data.previousReport?.complete !== false ? data.previousForm?.periodOfReport : undefined,
  ].filter((period): period is string => !!period);
}

/**
 * The latest quarter end both funds reported among their two most recent
 * reports, so a fund that has not filed the newest quarter yet still compares.
 */
export function overlapPeriod(first: FundDetailData, second: FundDetailData): string | null {
  const periods = new Set(comparablePeriods(second));
  return comparablePeriods(first).filter(period => periods.has(period)).sort().at(-1) ?? null;
}

/** The fund's report for a period, as if it were the latest, with no prior quarter to show exits against. */
function atPeriod(data: FundDetailData, period: string): FundDetailData | null {
  if (data.latestForm?.periodOfReport === period) return data;
  if (data.previousForm?.periodOfReport !== period || data.previousReport?.complete === false) return null;
  return { ...data, latestForm: data.previousForm, latestReport: data.previousReport, latestHoldings: data.previousHoldings, previousForm: null, previousReport: undefined, previousHoldings: [] };
}

export function buildFundOverlap(first: FundDetailData, second: FundDetailData): FundOverlapRow[] {
  const period = overlapPeriod(first, second);
  const left = period ? atPeriod(first, period) : null;
  const right = period ? atPeriod(second, period) : null;
  if (!left || !right) return [];
  // Rows are keyed by CUSIP, option side and share type, including when ticker aliases change.
  const peer = new Map(buildFundHoldingRows(right).filter(row => row.action !== "exit").map(row => [row.id, row]));
  return buildFundHoldingRows(left).filter(row => row.action !== "exit" && peer.has(row.id)).map(row => ({
    id: row.id, ticker: row.ticker, issuer: row.issuer, type: row.putCall || row.shareType,
    weight: row.weight, comparedWeight: peer.get(row.id)!.weight,
  })).sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1));
}
