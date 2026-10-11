import type { CloudCdsHistoryPointPayload, CloudCdsTradePayload } from "../../../api-client";
import type { DataTableColumn, StatItem } from "../../../components";
import type { TimeSeriesPoint } from "../../../time-series/types";
import type { HeadlessPaneFreshness } from "../../../types/headless";
import type { TickerRecord } from "../../../types/ticker";
import { formatCompact } from "../../../utils/format";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";

export const CDS_PANE_ID = "cds";

/**
 * Raw DTCC values are decimals: `Fixed rate-Leg 1 = 0.01` is a 100bp coupon and
 * `Spread-Leg 1 = 0.00256` under notation code "3" is 25.6bp. Spread notation
 * "4" is already basis points; "1" is monetary and cannot supply a bp rate.
 * Conversions happen here and nowhere else.
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
  /** Source inputs retained even when their notation cannot supply a bp rate. */
  reportedSpread: number | null;
  spreadNotation: string | null;
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
  /** The newest spread a trade reported, when any did. */
  latestSpreadBp: number | null;
  /** The latest level of the issuer's 5Y line and its date, where it has one: what the list ranks by. */
  spread5yBp: number | null;
  spread5yDate: string | null;
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
  const folded = tokens.join(" ");
  if (
    tokens.length === 0
    || NAME_PLACEHOLDERS.has(folded)
    || folded.startsWith("medium term note")
  ) return false;
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

/**
 * DTCC writes a comma inside a field as `;` ("CCO Holdings;LLC",
 * "Amazon.com;Inc."), so a name gets its comma back before it is shown,
 * grouped or sent as a query.
 */
export function displayIssuerName(name: string): string {
  return name.replace(/\s*;\s*/g, ", ").trim();
}

/**
 * What a listing's name says about the security rather than the company:
 * share class, stock or receipt type. The tape names issuers, never their
 * shares, so "Alphabet Inc. Class A Common Stock" has to become "Alphabet Inc.".
 */
const SECURITY_SUFFIX = /[\s,-]+(?:(?:class|series)\s+[a-z0-9]{1,2}|common|ordinary|stock|shares?|(?:american\s+)?(?:depositary|depository)(?:\s+(?:shares?|receipts?))?|ads|adrs?)$/i;

/** The issuer a listing's name stands for, as the tape would name it: its comma back, its share class gone. */
export function issuerNameOf(name: string): string {
  let current = displayIssuerName(name);
  for (;;) {
    const next = current.replace(SECURITY_SUFFIX, "").trim();
    if (next === current || !next) return current;
    current = next;
  }
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
  const unit = (notation ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  let multiplier: number;
  if (["4", "bp", "bps", "basispoint", "basispoints", "basis point", "basis points"].includes(unit)) multiplier = 1;
  else if (["%", "percent", "percentage"].includes(unit)) multiplier = PERCENT_TO_BP;
  // Unlabelled values retain the existing raw-decimal feed contract. An explicit
  // monetary or unknown unit must not silently inherit that fallback.
  else if (["", "3", "decimal"].includes(unit)) multiplier = DECIMAL_TO_BP;
  else return null;
  const result = value * multiplier;
  return Number.isFinite(result) ? result : null;
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
  if (reported) return displayIssuerName(reported);
  const underlier = trade.upiUnderlierName?.trim();
  return underlier && identifiesIssuer(underlier) ? displayIssuerName(underlier) : null;
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
      reportedSpread: trade.reportedSpread,
      spreadNotation: trade.spreadNotation,
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
        spread5yBp: null,
        spread5yDate: null,
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

/** The latest 5Y level and its date, by issuer key. */
export type CdsSpreadLevels = ReadonlyMap<string, { spreadBp: number; date: string }>;

/** Each issuer with the latest level of its 5Y line, where it has one, so the list ranks by it. */
export function withSpreadLevels(rows: readonly CdsIssuerSummary[], levels: CdsSpreadLevels | null): CdsIssuerSummary[] {
  if (!levels?.size) return [...rows];
  return rows.map((row) => {
    const level = levels.get(row.key);
    return level ? { ...row, spread5yBp: level.spreadBp, spread5yDate: level.date } : row;
  });
}

export function tradesForIssuer(trades: readonly CdsTrade[], issuerKey: string): CdsTrade[] {
  return trades.filter((trade) => trade.issuerKey === issuerKey);
}

/**
 * When the view was last traded: its newest print, or the last day its 5Y
 * line has a level when no print is in the window. Null when neither is.
 */
export function lastTradeOf(
  trades: readonly Pick<CdsTrade, "eventAt">[],
  points: readonly Pick<CloudCdsHistoryPointPayload, "date">[] = [],
): number | string | null {
  const newest = trades.reduce<number | null>((latest, trade) => (latest == null || trade.eventAt > latest ? trade.eventAt : latest), null);
  const lineDate = points.at(-1)?.date ?? null;
  if (newest == null) return lineDate;
  return lineDate && Date.parse(`${lineDate}T00:00:00Z`) > newest ? lineDate : newest;
}

/**
 * How current a CDS view is, the same at the end of `fn`, in the pane footer
 * and on a shot: dated by its last trade, never by when the tape was fetched,
 * with how many days that trade is behind:
 * `Source: DTCC · last trade 2026-10-09 · lag 2 days`.
 */
export function cdsFreshness(lastTrade: number | string | null): HeadlessPaneFreshness {
  return {
    source: "DTCC",
    // Public dissemination of swap trades, held back by rule for some trades.
    status: "delayed",
    dataset: true,
    observation: "last trade",
    asOf: typeof lastTrade === "number" ? new Date(lastTrade).toISOString() : lastTrade,
    // The rows are a history, whose first entry is not stale data.
    oldest: null,
  };
}

/**
 * What an empty view says: the window searched and, for one name, the
 * reference entity the query became, with what was typed when that differs.
 */
export function noTradesMessage({ query, issuer, days }: {
  query: string | null;
  issuer: string | null;
  days: number;
}): string {
  const window = `in the last ${days} days`;
  if (!query) return `No single-name CDS trades ${window}.`;
  const name = issuer && issuer.toUpperCase() !== query.toUpperCase() ? `${issuer} (${query})` : issuer ?? query;
  return `No CDS trades for ${name} ${window}.`;
}

/**
 * Listed companies whose CDS references another entity than the one their
 * shares trade as, usually the subsidiary or holding company that issues the
 * debt. The tape never names the listed parent, so its name would match no
 * trade. Every name here matches the entity's own spellings on the tape.
 */
const CDS_REFERENCE_ENTITIES: Readonly<Record<string, string>> = {
  CHTR: "CCO Holdings, LLC",
  GNW: "Genworth Holdings, Inc.",
  HLT: "Hilton Domestic Operating Company Inc.",
  HRB: "Block Financial LLC",
  HTZ: "The Hertz Corporation",
  IHRT: "iHeartCommunications, Inc.",
  MPW: "MPT Operating Partnership, LP",
  NCLH: "NCL Corporation Ltd.",
  NXST: "Nexstar Media Inc.",
  OMF: "OneMain Finance Corporation",
  PARA: "Paramount Global",
  PSKY: "Paramount Global",
  SIRI: "Sirius XM Radio LLC",
  TMUS: "T-Mobile USA, Inc.",
};

/** The reference entity a ticker's CDS trades under, when it is not the listed company. */
export function cdsReferenceEntity(symbol: string): string | null {
  return CDS_REFERENCE_ENTITIES[symbol.trim().toUpperCase()] ?? null;
}

/**
 * What the pane asks for. A tracked ticker already carries its company name; an
 * untracked one, or one whose CDS references another entity, yields the bare
 * symbol, which the loader expands before it reaches the backend.
 */
export function resolveIssuerQuery(
  symbol: string | null,
  ticker: TickerRecord | null,
): string | null {
  const bare = symbol?.trim().toUpperCase() || null;
  if (bare && cdsReferenceEntity(bare)) return bare;
  return ticker?.metadata.name?.trim() || bare;
}

export function formatBp(value: number | null): string {
  if (value == null) return "--";
  return `${Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10}bp`;
}

export function formatNotional(trade: Pick<CdsTrade, "notional" | "notionalCapped">): string {
  if (trade.notional == null) return "--";
  return `${formatCompact(trade.notional)}${trade.notionalCapped ? "+" : ""}`;
}

/**
 * DTCC publishes the upfront without a direction, and who paid it is not
 * public, so it is an absolute amount: never signed, and labelled `abs`
 * where it is shown.
 */
export function formatUpfront(trade: Pick<CdsTrade, "upfront" | "upfrontCurrency">): string {
  if (trade.upfront == null) return "--";
  return `${formatCompact(Math.abs(trade.upfront))}${trade.upfrontCurrency ? ` ${trade.upfrontCurrency}` : ""}`;
}

/**
 * `2026-10-09 13:21`, in UTC: DTCC disseminates in UTC, a guessed local zone
 * misdates prints, and `10/09` reads as 10 September to most of the world.
 */
export function formatEventTime(eventAt: number): string {
  if (!Number.isFinite(eventAt)) return "--";
  return new Date(eventAt).toISOString().slice(0, 16).replace("T", " ");
}

export function formatAsOf(asOf: string | null): string | null {
  if (!asOf) return null;
  const parsed = Date.parse(asOf);
  return Number.isFinite(parsed) ? `${formatEventTime(parsed)} UTC` : asOf;
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

/** The issuer takes the room the figures leave; the table lays it out. */
export function buildIssuerColumns(): IssuerColumn[] {
  return [
    { id: "issuer", label: "ISSUER", width: 16, align: "left", flexGrow: 1 },
    { id: "trades", label: "TRADES", width: 7, align: "right" },
    { id: "last", label: "LAST UTC", width: 16, align: "left" },
    { id: "spread", label: "5Y SPREAD", width: 10, align: "right" },
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
      return row.spread5yBp;
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
  const maturityWidth = Math.max(10, Math.min(12, width - 59));
  return [
    { id: "time", label: "TIME UTC", width: 16, align: "left" },
    { id: "maturity", label: "MATURITY", width: maturityWidth, align: "left" },
    { id: "notional", label: "NOTIONAL", width: 11, align: "right" },
    { id: "currency", label: "CCY", width: 5, align: "left" },
    { id: "coupon", label: "COUPON", width: 9, align: "right" },
    { id: "spread", label: "SPREAD", width: 10, align: "right" },
    { id: "upfront", label: "ABS UPFRONT", width: 13, align: "right" },
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

const DAY_MS = 86_400_000;

/** Three weeks without a level breaks the line instead of drawing one nobody traded. */
const CHART_GAP_MS = 21 * DAY_MS;

export function spreadChartPoints(points: readonly CloudCdsHistoryPointPayload[]): TimeSeriesPoint[] {
  const out: TimeSeriesPoint[] = [];
  let previous: number | null = null;
  for (const point of points) {
    const time = Date.parse(`${point.date}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    if (previous !== null && time - previous > CHART_GAP_MS) {
      const gap = new Date(previous + DAY_MS);
      out.push({ date: gap, observedAt: gap, value: null });
    }
    const date = new Date(time);
    out.push({ date, observedAt: date, value: point.spreadBp });
    previous = time;
  }
  return out;
}

/** The 1M move as the pane shows it: whole basis points, signed. */
export function formatSpreadChange(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}bp`;
}

function dayTime(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** The figures of an issuer's 5Y line, the ones the pane heads its chart with and a report carries. */
export interface CdsSpreadSummary {
  /** The latest level, bp, and the New York trade date it is from. */
  spreadBp: number;
  date: string;
  /** The move over a month on the same contract; null across a roll or a gap. */
  change1mBp: number | null;
  /** Lowest and highest level since the first date charted; null with a single level. */
  range: { lowBp: number; highBp: number; since: string } | null;
}

/**
 * The latest level, its move over a month, and the range of what the chart
 * shows. The month compares against the last level 30 to 45 days older on the
 * same contract, so neither a gap nor a roll to the next contract, which
 * trades wider, passes for a move.
 */
export function spreadSummary(points: readonly CloudCdsHistoryPointPayload[]): CdsSpreadSummary | null {
  const latest = points.at(-1);
  if (!latest) return null;
  const latestTime = dayTime(latest.date);
  const monthAgo = points.findLast((point) => {
    if (point.maturity !== latest.maturity) return false;
    const age = latestTime - dayTime(point.date);
    return age >= 30 * DAY_MS && age <= 45 * DAY_MS;
  });
  const levels = points.map((point) => point.spreadBp);
  return {
    spreadBp: latest.spreadBp,
    date: latest.date,
    // A tenth of a basis point is the line's own precision; the rest is float noise.
    change1mBp: monthAgo ? Math.round((latest.spreadBp - monthAgo.spreadBp) * 10) / 10 : null,
    range: points.length >= 2
      ? { lowBp: Math.min(...levels), highBp: Math.max(...levels), since: points[0]!.date }
      : null,
  };
}

/** `129 to 276bp`: the low keeps the level's precision, so the level never falls outside it. */
export function formatSpreadRange(range: NonNullable<CdsSpreadSummary["range"]>): string {
  return `${formatBp(range.lowBp).slice(0, -2)} to ${formatBp(range.highBp)}`;
}

/** The pane's figures over its 5Y chart, from `spreadSummary`. */
export function spreadFigures(points: readonly CloudCdsHistoryPointPayload[]): StatItem[] {
  const summary = spreadSummary(points);
  if (!summary) return [];
  return [
    { id: "spread", label: "5Y spread", value: formatBp(summary.spreadBp), detail: summary.date },
    ...(summary.change1mBp != null ? [{ id: "change", label: "1M", value: formatSpreadChange(summary.change1mBp) }] : []),
    ...(summary.range ? [{
      id: "range",
      label: "Range",
      value: formatSpreadRange(summary.range),
      detail: `since ${summary.range.since}`,
    }] : []),
  ];
}
