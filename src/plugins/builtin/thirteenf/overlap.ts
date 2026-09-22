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
export function buildFundOverlap(first: FundDetailData, second: FundDetailData): FundOverlapRow[] {
  if (!first.latestForm || first.latestForm.periodOfReport !== second.latestForm?.periodOfReport) return [];
  // Rows are keyed by CUSIP, option side and share type, including when ticker aliases change.
  const peer = new Map(buildFundHoldingRows(second).filter(row => row.action !== "exit").map(row => [row.id, row]));
  return buildFundHoldingRows(first).filter(row => row.action !== "exit" && peer.has(row.id)).map(row => ({
    id: row.id, ticker: row.ticker, issuer: row.issuer, type: row.putCall || row.shareType,
    weight: row.weight, comparedWeight: peer.get(row.id)!.weight,
  })).sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1));
}
