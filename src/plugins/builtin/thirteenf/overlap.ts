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

/** One line of an ETF's holdings file, as MEMB lists it: weight is a fraction of the fund. */
export interface EtfHoldingLine {
  symbol: string | null;
  weight: number | null;
}

export interface ManagerEtfRow {
  id: string;
  ticker: string;
  issuer: string;
  /** Share of the manager's 13F share positions. */
  weight: number;
  /** Share of the ETF: 0 when it does not hold the name, null when the 13F line has no ticker to match. */
  etfWeight: number | null;
  /** The smaller of the two weights: how much of this position the ETF already holds. */
  shared: number;
}

export interface ManagerEtfOverlap {
  /** The manager's share positions, largest first. */
  rows: ManagerEtfRow[];
  /** Sum of the smaller weight per name. */
  overlap: number;
  /** Half the summed absolute weight differences over every name either holds. */
  activeShare: number;
  /** The manager's positions the ETF does not hold, or that have no ticker to match, largest first. */
  missing: ManagerEtfRow[];
  missingWeight: number;
  /** 13F lines left out of the weights: options, and principal amounts that are not shares. */
  leftOut: { options: number; principal: number };
}

/** BRK.B in a 13F and BRK-B in a holdings file are one share class. */
const symbolKey = (symbol: string) => symbol.trim().toUpperCase().replace(/[./\s]+/g, "-");

/**
 * A manager's latest 13F against an ETF's holdings file. The manager's weights
 * cover its share positions (options and principal amounts left out), the
 * ETF's its whole file (cash and lines without a ticker included), so both sum
 * to one and active share is one minus the overlap.
 */
export function buildManagerEtfOverlap(manager: FundDetailData, etf: readonly EtfHoldingLine[]): ManagerEtfOverlap | null {
  const lines = buildFundHoldingRows(manager).filter((row) => row.action !== "exit" && row.value != null && row.value > 0);
  const leftOut = { options: 0, principal: 0 };
  const positions = new Map<string, { id: string; ticker: string; issuer: string; value: number }>();
  for (const row of lines) {
    if (row.putCall) { leftOut.options += 1; continue; }
    if (row.shareType.toUpperCase() === "PRN") { leftOut.principal += 1; continue; }
    const key = row.ticker ? symbolKey(row.ticker) : `cusip:${row.cusip || row.id}`;
    const position = positions.get(key);
    if (position) position.value += row.value!;
    else positions.set(key, { id: row.id, ticker: row.ticker, issuer: row.issuer, value: row.value! });
  }
  const total = [...positions.values()].reduce((sum, row) => sum + row.value, 0);
  const etfWeights = new Map<string, number>();
  let etfTotal = 0;
  for (const line of etf) {
    if (line.weight == null || !Number.isFinite(line.weight) || line.weight <= 0) continue;
    etfTotal += line.weight;
    if (line.symbol) etfWeights.set(symbolKey(line.symbol), (etfWeights.get(symbolKey(line.symbol)) ?? 0) + line.weight);
  }
  if (!(total > 0) || !(etfTotal > 0)) return null;
  const rows = [...positions].map(([key, row]): ManagerEtfRow => {
    const weight = row.value / total;
    const etfWeight = row.ticker ? (etfWeights.get(key) ?? 0) / etfTotal : null;
    return { id: row.id, ticker: row.ticker, issuer: row.issuer, weight, etfWeight, shared: Math.min(weight, etfWeight ?? 0) };
  }).sort((a, b) => b.weight - a.weight);
  const overlap = rows.reduce((sum, row) => sum + row.shared, 0);
  // The ETF's weight in names the manager does not hold, cash and untickered lines included.
  const etfOnly = 1 - rows.reduce((sum, row) => sum + (row.etfWeight ?? 0), 0);
  const activeShare = (rows.reduce((sum, row) => sum + Math.abs(row.weight - (row.etfWeight ?? 0)), 0) + Math.max(0, etfOnly)) / 2;
  const missing = rows.filter((row) => !row.etfWeight);
  return { rows, overlap, activeShare, missing, missingWeight: missing.reduce((sum, row) => sum + row.weight, 0), leftOut };
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
