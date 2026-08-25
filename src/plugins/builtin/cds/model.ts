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
  /** Reported spelling, kept verbatim so a display name can be chosen later. */
  issuer: string;
  /** Alias-collapsed grouping key. Internal only; never shown or sent. */
  issuerKey: string;
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
  /** Grouping key, and the row's selection id. */
  key: string;
  /** Best spelling among the aliases in this group. */
  issuer: string;
  trades: number;
  lastTradeAt: number;
  latestSpreadBp: number | null;
}

/**
 * Legal-name noise the tape spells inconsistently: "Oracle Corporation",
 * "ORACLE CORPORATION", and "Oracle Cop" are one issuer. Only suffixes and
 * articles belong here. Words that distinguish real entities, such as holdings,
 * group, or a year, must keep their own row.
 */
const LEGAL_NAME_NOISE = new Set([
  "the", "co", "company", "corp", "corporation", "cop",
  "inc", "incorporated", "limited", "ltd", "plc",
]);

/**
 * Obligation vocabulary the tape writes into `UPI Underlier Name` when it has
 * no reference entity: seniority, instrument type, format, rule reference, and
 * currency. A name built only from these describes a bond, not an issuer.
 */
const OBLIGATION_NOISE = new Set([
  "sr", "senior", "sub", "subordinated", "jr", "junior",
  "nt", "nts", "note", "notes", "bd", "bds", "bond", "bonds",
  "gtd", "guaranteed", "global", "medium", "term", "mtn", "emtn",
  "144a", "regs", "s", "call",
  "eur", "usd", "gbp", "jpy", "chf", "cad", "aud",
]);

/** Whole-string sentinels the feed sends instead of leaving the field empty. */
const NAME_PLACEHOLDERS = new Set([
  "no name obtainable", "name not available", "not available", "unknown", "n a",
]);

/** Case, accents, and punctuation folded away into comparable tokens. */
function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Whether a `UPI Underlier Name` names a company at all. "SR GTD NT 144A" and
 * "MEDIUM TERM NOTES EUR 2.3750 S.10/CALL" are obligation descriptions that
 * would otherwise become fake issuers and outrank real ones, while
 * "Tencent Holdings Limited" and "DT.BANK MTN 17/20" carry a real entity.
 */
function identifiesIssuer(name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.length === 0 || NAME_PLACEHOLDERS.has(tokens.join(" "))) return false;
  return tokens.some((token) => (
    !OBLIGATION_NOISE.has(token)
    && !LEGAL_NAME_NOISE.has(token)
    && !/^\d+$/.test(token)
  ));
}

/** Case, accents, and punctuation folded away, then legal-name noise dropped. */
export function issuerGroupKey(name: string): string {
  const tokens = nameTokens(name);
  const meaningful = tokens.filter((token) => !LEGAL_NAME_NOISE.has(token));
  // A name made only of noise ("The Company") keeps its tokens rather than
  // collapsing every such issuer into one empty-key row.
  return (meaningful.length > 0 ? meaningful : tokens).join(" ") || name.trim().toLowerCase();
}

/** Mixed case reads as a real name; all-caps is the tape shouting. */
function isMixedCase(name: string): boolean {
  return name !== name.toUpperCase();
}

/**
 * Picks the spelling a human would write. Mixed case wins over all-caps first,
 * then the longer name, so a full legal name beats an abbreviated or inverted
 * one ("Oracle Corporation" over "Oracle Cop", "The Boeing Company" over
 * "Boeing Co/The"). Ties break lexically so refreshes do not reshuffle.
 */
function preferredIssuerName(current: string, candidate: string): string {
  const currentMixed = isMixedCase(current);
  const candidateMixed = isMixedCase(candidate);
  if (currentMixed !== candidateMixed) return candidateMixed ? candidate : current;
  if (current.length !== candidate.length) return candidate.length > current.length ? candidate : current;
  return candidate.localeCompare(current) < 0 ? candidate : current;
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

/**
 * A reported issuer name is always trusted, even when the UPI underlier beside
 * it is generic. Otherwise the UPI name is used only when it names a company.
 * There is no third fallback: underlier IDs are opaque instrument codes, so
 * showing one would just be a different kind of fake issuer.
 */
function issuerOf(trade: CloudCdsTradePayload): string | null {
  const reported = trade.issuerName?.trim();
  if (reported) return reported;
  const underlier = trade.upiUnderlierName?.trim();
  return underlier && identifiesIssuer(underlier) ? underlier : null;
}

export function normalizeCdsTrades(trades: readonly CloudCdsTradePayload[]): CdsTrade[] {
  const rows: CdsTrade[] = [];
  for (const trade of trades) {
    const eventAt = tapeTime(trade);
    if (eventAt == null) continue;
    const issuer = issuerOf(trade);
    // Nothing names the reference entity, so the row would invent one.
    if (!issuer) continue;
    rows.push({
      id: trade.disseminationId,
      issuer,
      issuerKey: issuerGroupKey(issuer),
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
    const current = byIssuer.get(trade.issuerKey);
    if (!current) {
      byIssuer.set(trade.issuerKey, {
        key: trade.issuerKey,
        issuer: trade.issuer,
        trades: 1,
        lastTradeAt: trade.eventAt,
        latestSpreadBp: trade.spreadBp,
      });
      if (trade.spreadBp != null) spreadAt.set(trade.issuerKey, trade.eventAt);
      continue;
    }
    current.trades += 1;
    current.issuer = preferredIssuerName(current.issuer, trade.issuer);
    if (trade.eventAt > current.lastTradeAt) current.lastTradeAt = trade.eventAt;
    if (trade.spreadBp != null && trade.eventAt >= (spreadAt.get(trade.issuerKey) ?? -Infinity)) {
      current.latestSpreadBp = trade.spreadBp;
      spreadAt.set(trade.issuerKey, trade.eventAt);
    }
  }
  return [...byIssuer.values()];
}

export function tradesForIssuer(trades: readonly CdsTrade[], issuerKey: string): CdsTrade[] {
  return trades.filter((trade) => trade.issuerKey === issuerKey);
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
