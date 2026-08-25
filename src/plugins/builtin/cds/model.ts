import type { CloudCdsTradePayload } from "../../../api-client";
import type { DataTableColumn } from "../../../components";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { formatCompact } from "../../../utils/format";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";

export const CDS_PANE_ID = "cds";

/**
 * Raw DTCC values are decimals: `Fixed rate-Leg 1 = 0.01` is a 100bp coupon and
 * `Spread-Leg 1 = 0.00256` under notation code "3" is 25.6bp. Only a report that
 * explicitly labels itself basis points or percent is read any other way. Both
 * conversions happen here and nowhere else.
 */
const PERCENT_TO_BP = 100;
const DECIMAL_TO_BP = 10_000;

export interface CdsTrade {
  id: string;
  issuer: string;
  /** Execution time when the report carried a usable one, else event time. */
  eventAt: number;
  maturity: string | null;
  notional: number | null;
  notionalCapped: boolean;
  currency: string | null;
  couponBp: number | null;
  /** Only what the report carried. Never derived from upfront or coupon. */
  spreadBp: number | null;
  upfront: number | null;
  upfrontCurrency: string | null;
}

export interface CdsIssuerSummary {
  issuer: string;
  trades: number;
  lastTradeAt: number;
  latestSpreadBp: number | null;
}

export function spreadToBasisPoints(value: number | null, notation: string | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const unit = (notation ?? "").trim().toLowerCase();
  if (unit.startsWith("bp") || unit.includes("basis")) return value;
  if (unit.includes("percent") || unit === "%") return value * PERCENT_TO_BP;
  // Notation code "3", textual "decimal", and an unlabelled raw value are all decimals.
  return value * DECIMAL_TO_BP;
}

function couponToBasisPoints(fixedRate: number | null): number | null {
  if (fixedRate == null || !Number.isFinite(fixedRate)) return null;
  return fixedRate * DECIMAL_TO_BP;
}

/**
 * When the trade was struck, not when the tape carried it. A lifecycle
 * correction is disseminated long after the fact, so using the event time would
 * date an old trade as new.
 */
function tapeTime(trade: CloudCdsTradePayload): number | null {
  const executed = trade.executionTimestamp ? Date.parse(trade.executionTimestamp) : Number.NaN;
  if (Number.isFinite(executed)) return executed;
  const event = Date.parse(trade.eventTimestamp);
  return Number.isFinite(event) ? event : null;
}

function issuerOf(trade: CloudCdsTradePayload): string {
  const named = trade.issuerName?.trim()
    || trade.upiUnderlierName?.trim()
    || trade.underlierId?.trim();
  return named || "Unknown issuer";
}

export function normalizeCdsTrades(trades: readonly CloudCdsTradePayload[]): CdsTrade[] {
  const rows: CdsTrade[] = [];
  for (const trade of trades) {
    const eventAt = tapeTime(trade);
    if (eventAt == null) continue;
    rows.push({
      id: trade.disseminationId,
      issuer: issuerOf(trade),
      eventAt,
      maturity: trade.maturityDate ?? trade.expirationDate,
      notional: trade.notionalAmount,
      notionalCapped: trade.notionalCapped,
      currency: trade.notionalCurrency,
      couponBp: couponToBasisPoints(trade.fixedRate),
      spreadBp: spreadToBasisPoints(trade.reportedSpread, trade.spreadNotation),
      upfront: trade.upfrontAmount,
      upfrontCurrency: trade.upfrontCurrency,
    });
  }
  return rows;
}

/**
 * Most-active issuers, with the spread of each issuer's newest report that
 * actually carried one. A quoted issuer whose last print omitted the spread
 * keeps its last known level instead of falling back to "--".
 */
export function summarizeIssuers(trades: readonly CdsTrade[]): CdsIssuerSummary[] {
  const byIssuer = new Map<string, CdsIssuerSummary>();
  const spreadAt = new Map<string, number>();
  for (const trade of trades) {
    const current = byIssuer.get(trade.issuer);
    if (!current) {
      byIssuer.set(trade.issuer, {
        issuer: trade.issuer,
        trades: 1,
        lastTradeAt: trade.eventAt,
        latestSpreadBp: trade.spreadBp,
      });
      if (trade.spreadBp != null) spreadAt.set(trade.issuer, trade.eventAt);
      continue;
    }
    current.trades += 1;
    if (trade.eventAt > current.lastTradeAt) current.lastTradeAt = trade.eventAt;
    if (trade.spreadBp != null && trade.eventAt >= (spreadAt.get(trade.issuer) ?? -Infinity)) {
      current.latestSpreadBp = trade.spreadBp;
      spreadAt.set(trade.issuer, trade.eventAt);
    }
  }
  return [...byIssuer.values()];
}

export function tradesForIssuer(trades: readonly CdsTrade[], issuer: string): CdsTrade[] {
  return trades.filter((trade) => trade.issuer === issuer);
}

/**
 * The company name the backend matches on. An untracked symbol has no
 * TickerRecord, but its quote arrives with a name shortly after the pane opens,
 * so the raw symbol is only the last resort.
 */
export function resolveIssuerQuery(
  symbol: string | null,
  ticker: TickerRecord | null,
  financials: TickerFinancials | null,
): string | null {
  return ticker?.metadata.name?.trim()
    || financials?.quote?.name?.trim()
    || symbol?.trim().toUpperCase()
    || null;
}

export function formatBp(value: number | null): string {
  if (value == null) return "--";
  return `${Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10}bp`;
}

export function formatNotional(trade: Pick<CdsTrade, "notional" | "notionalCapped">): string {
  if (trade.notional == null) return "--";
  return `${formatCompact(trade.notional)}${trade.notionalCapped ? "+" : ""}`;
}

export function formatUpfront(trade: Pick<CdsTrade, "upfront" | "upfrontCurrency">): string {
  if (trade.upfront == null) return "--";
  const sign = trade.upfront > 0 ? "+" : "";
  return `${sign}${formatCompact(trade.upfront)}${trade.upfrontCurrency ? ` ${trade.upfrontCurrency}` : ""}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTC, because DTCC disseminates in UTC and a guessed local zone misdates prints. */
export function formatEventTime(eventAt: number): string {
  const date = new Date(eventAt);
  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function formatAsOf(asOf: string | null): string | null {
  if (!asOf) return null;
  const parsed = Date.parse(asOf);
  return Number.isFinite(parsed) ? `${formatEventTime(parsed)}Z` : asOf;
}

export function formatMaturity(maturity: string | null): string {
  return maturity ?? "--";
}

export type IssuerColumnId = "issuer" | "trades" | "last" | "spread";
export type IssuerColumn = DataTableColumn & { id: IssuerColumnId };
export type IssuerSortPreference = SortPreference<IssuerColumnId>;

export const ISSUER_SORT_COLUMN_IDS: readonly IssuerColumnId[] = ["issuer", "trades", "last", "spread"];
/** "Most active" is the reason the market-wide view exists. */
export const DEFAULT_ISSUER_SORT: IssuerSortPreference = { columnId: "trades", direction: "desc" };

export function buildIssuerColumns(width: number): IssuerColumn[] {
  const issuerWidth = Math.max(16, width - 35);
  return [
    { id: "issuer", label: "ISSUER", width: issuerWidth, align: "left" },
    { id: "trades", label: "TRADES", width: 7, align: "right" },
    { id: "last", label: "LAST UTC", width: 12, align: "left" },
    { id: "spread", label: "SPREAD", width: 10, align: "right" },
  ];
}

function issuerSortValue(columnId: IssuerColumnId, row: CdsIssuerSummary): string | number | null {
  switch (columnId) {
    case "issuer":
      return row.issuer;
    case "trades":
      return row.trades;
    case "last":
      return row.lastTradeAt;
    case "spread":
      return row.latestSpreadBp;
  }
}

export function sortIssuers(
  rows: readonly CdsIssuerSummary[],
  sort: IssuerSortPreference,
): CdsIssuerSummary[] {
  const columnId = sort.columnId;
  if (!columnId) return [...rows];
  return [...rows].sort((left, right) => {
    const compared = compareSortValues(
      issuerSortValue(columnId, left),
      issuerSortValue(columnId, right),
      sort.direction,
    );
    // Stable secondary key so equal counts do not reshuffle between refreshes.
    return compared !== 0 ? compared : left.issuer.localeCompare(right.issuer);
  });
}

export type TradeColumnId = "time" | "maturity" | "notional" | "currency" | "coupon" | "spread" | "upfront";
export type TradeColumn = DataTableColumn & { id: TradeColumnId };
export type TradeSortPreference = SortPreference<TradeColumnId>;

export const TRADE_SORT_COLUMN_IDS: readonly TradeColumnId[] = [
  "time",
  "maturity",
  "notional",
  "coupon",
  "spread",
  "upfront",
];
export const DEFAULT_TRADE_SORT: TradeSortPreference = { columnId: "time", direction: "desc" };

export function buildTradeColumns(width: number): TradeColumn[] {
  const maturityWidth = Math.max(10, Math.min(12, width - 55));
  return [
    { id: "time", label: "TIME UTC", width: 12, align: "left" },
    { id: "maturity", label: "MATURITY", width: maturityWidth, align: "left" },
    { id: "notional", label: "NOTIONAL", width: 11, align: "right" },
    { id: "currency", label: "CCY", width: 5, align: "left" },
    { id: "coupon", label: "COUPON", width: 9, align: "right" },
    { id: "spread", label: "SPREAD", width: 10, align: "right" },
    { id: "upfront", label: "UPFRONT", width: 13, align: "right" },
  ];
}

function tradeSortValue(columnId: TradeColumnId, row: CdsTrade): string | number | null {
  switch (columnId) {
    case "time":
      return row.eventAt;
    case "maturity":
      return row.maturity;
    case "notional":
      return row.notional;
    case "currency":
      return row.currency;
    case "coupon":
      return row.couponBp;
    case "spread":
      return row.spreadBp;
    case "upfront":
      return row.upfront;
  }
}

export function sortTrades(rows: readonly CdsTrade[], sort: TradeSortPreference): CdsTrade[] {
  const columnId = sort.columnId;
  if (!columnId) return [...rows];
  return [...rows].sort((left, right) => {
    const compared = compareSortValues(
      tradeSortValue(columnId, left),
      tradeSortValue(columnId, right),
      sort.direction,
    );
    return compared !== 0 ? compared : right.eventAt - left.eventAt;
  });
}

export function nextSort<Id extends string>(
  current: SortPreference<Id>,
  columnId: Id,
  fallback: SortPreference<Id>,
): SortPreference<Id> {
  if (current.columnId !== columnId) return { columnId, direction: "asc" };
  if (current.direction === "asc") return { columnId, direction: "desc" };
  return fallback;
}
