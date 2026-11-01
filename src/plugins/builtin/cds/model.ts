import type { CloudCdsHistoryPointPayload, CloudCdsLevelPayload, CloudCdsTradePayload } from "../../../api-client";
import type { DataTableColumn, StatItem } from "../../../components";
import type { TimeSeriesPoint } from "../../../time-series/types";
import type { HeadlessPaneFreshness } from "../../../types/headless";
import type { TickerRecord } from "../../../types/ticker";
import { formatCompact } from "../../../utils/format";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import { typoDistance } from "../../../utils/typo-distance";
import { formatMove, SETTLEMENT_TEXT } from "../credit-boards/model";

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
  /** The issuer's best spelling on the tape, the same on every print of it (see `normalizeCdsTrades`). */
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
  /**
   * Only what the report carried. Never derived from upfront or coupon, and
   * empty when the field held points upfront (`pointsUpfront`).
   */
  spreadBp: number | null;
  /** The quote of a print whose spread field held points upfront, not bp. */
  pointsUpfront: number | null;
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
  /** That level's 1W and 1M moves in bp, through the roll, while the level is current. */
  change1wBp: number | null;
  change1mBp: number | null;
  /** How the level is quoted: in bp, or past 2,000bp in points upfront. */
  quote: CdsQuote;
  /** Quoted upfront: the level in points on its running coupon, and its 1W and 1M moves in points. */
  upfrontPts: number | null;
  change1wPts: number | null;
  change1mPts: number | null;
  /** The running coupon of a name quoted upfront, bp. */
  couponBp: number | null;
}

/**
 * Past 2,000bp a name trades on points upfront over its running coupon, so the
 * server quotes it that way (`58.2 pts`), as the index board quotes HY in price.
 */
type CdsQuote = "spread" | "upfront";
export type CdsQuoteUnit = "bp" | "pts";

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

/** Fewer letters than this are a symbol, not words of a name: `f` is Ford's ticker, not "F&G Annuities & Life". */
const MIN_NAME_LETTERS = 3;

/**
 * The covered issuer a name stands for, by its words: the issuer of that very
 * name, else one whose name holds those words in a row (`goodyear` is "The
 * Goodyear Tire & Rubber Company"), one that starts with them first, then the
 * shortest, so `ford` is Ford Motor Company and not Ford Motor Credit. Null
 * when none does, and for fewer than three letters (`f`, `ge`), which are a
 * symbol to look up.
 */
export function coveredIssuerMatch(name: string, covered: readonly string[]): string | null {
  const wanted = issuerGroupKey(displayIssuerName(name));
  if (wanted.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_NAME_LETTERS) return null;
  let best: { issuer: string; leading: boolean; words: number } | null = null;
  for (const issuer of covered) {
    const key = issuerGroupKey(displayIssuerName(issuer));
    if (key === wanted) return displayIssuerName(issuer);
    if (!` ${key} `.includes(` ${wanted} `)) continue;
    const candidate = { issuer: displayIssuerName(issuer), leading: key.startsWith(`${wanted} `), words: key.split(" ").length };
    if (!best
      || (candidate.leading !== best.leading ? candidate.leading
        : candidate.words !== best.words ? candidate.words < best.words
          : candidate.issuer.localeCompare(best.issuer) < 0)) best = candidate;
  }
  return best?.issuer ?? null;
}

/** How many covered issuers an unmatched name offers. */
const CLOSEST_ISSUERS = 3;

/**
 * How near a word is to one of a name's: a slip of the keys, or the same first
 * letters (`goodyer`, `paramo`). Short words never count, or every name with
 * "co" in it would be close.
 */
function wordCloseness(typed: string, word: string): number {
  if (typed.length < 3 || word.length < 3) return 0;
  if (typed.length >= 4 && typoDistance(typed, word) <= 1) return typed.length;
  let shared = 0;
  while (shared < Math.min(typed.length, word.length) && typed[shared] === word[shared]) shared += 1;
  return shared >= 4 || (shared >= 3 && shared === typed.length) ? shared : 0;
}

/** The covered issuers closest to a name that matched none, closest first; none when nothing is near. */
export function closestCoveredIssuers(name: string, covered: readonly string[]): string[] {
  const typed = issuerGroupKey(displayIssuerName(name)).split(" ").filter(Boolean);
  const scored = new Map<string, number>();
  for (const issuer of covered) {
    const words = issuerGroupKey(displayIssuerName(issuer)).split(" ");
    const score = typed.reduce((sum, word) => sum + Math.max(0, ...words.map((other) => wordCloseness(word, other))), 0);
    const shown = displayIssuerName(issuer);
    if (score > 0 && score > (scored.get(shown) ?? 0)) scored.set(shown, score);
  }
  return [...scored]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, CLOSEST_ISSUERS)
    .map(([issuer]) => issuer);
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
 * How far a reported quote may sit from the points its upfront works out to
 * and still be read as those points: accrued and rounding move the amount by
 * about a tenth of a point.
 */
const POINTS_MATCH_PTS = 0.5;
const POINTS_MATCH_SHARE = 0.05;

/**
 * Some desks key a distressed name's points upfront into the spread field and
 * leave the coupon blank: Whirlpool's Dec 2028 contract printed `0.00065`,
 * 6.5 read as bp, beside 319,861 upfront on 5M, which is 6.4 points. Without a
 * coupon nothing makes the field a running spread, and when the amount over
 * the notional reads as the same number in points, it is that many points.
 * A real spread that low on a running coupon would need the upfront to land on
 * the same number by chance, below 5bp.
 */
function pointsUpfrontOf(
  spreadBp: number | null,
  couponBp: number | null,
  upfront: number | null,
  notional: number | null,
): number | null {
  if (couponBp != null || spreadBp == null || !(spreadBp > 0)) return null;
  if (upfront == null || !Number.isFinite(upfront) || notional == null || !(notional > 0)) return null;
  const impliedPts = (Math.abs(upfront) / notional) * 100;
  const tolerance = Math.max(POINTS_MATCH_PTS, impliedPts * POINTS_MATCH_SHARE);
  // The decimal the field holds carries float noise (0.001525 is 15.249999...).
  return Math.abs(spreadBp - impliedPts) <= tolerance ? Math.round(spreadBp * 1e6) / 1e6 : null;
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

/**
 * The tape's prints as rows. One issuer reads as one name on every print:
 * the tape spells Whirlpool three ways in a week ("WHIRLPOOL CORPORATION",
 * "Whirlpool Corp", "Whirlpool Corporation"), and each row takes the spelling
 * the issuer list shows for them all.
 */
export function normalizeCdsTrades(trades: readonly CloudCdsTradePayload[]): CdsTrade[] {
  const rows: CdsTrade[] = [];
  const names = new Map<string, string>();
  for (const trade of trades) {
    const eventAt = tapeTime(trade);
    if (eventAt == null) continue;
    const issuer = issuerOf(trade);
    // Nothing names the reference entity, so the row would invent one.
    if (!issuer) continue;
    const issuerKey = issuerGroupKey(issuer);
    const named = names.get(issuerKey);
    names.set(issuerKey, named ? preferredIssuerName(named, issuer) : issuer);
    const couponBp = couponToBasisPoints(trade.fixedRate);
    const reportedBp = spreadToBasisPoints(trade.reportedSpread, trade.spreadNotation);
    const pointsUpfront = pointsUpfrontOf(reportedBp, couponBp, trade.upfrontAmount, trade.notionalAmount);
    rows.push({
      id: trade.disseminationId,
      issuer,
      issuerKey,
      eventAt,
      maturity: trade.maturityDate ?? trade.expirationDate,
      notional: trade.notionalAmount,
      notionalCapped: trade.notionalCapped,
      currency: trade.notionalCurrency,
      couponBp,
      spreadBp: pointsUpfront == null ? reportedBp : null,
      pointsUpfront,
      reportedSpread: trade.reportedSpread,
      spreadNotation: trade.spreadNotation,
      upfront: trade.upfrontAmount,
      upfrontCurrency: trade.upfrontCurrency,
    });
  }
  return rows.map((row) => ({ ...row, issuer: names.get(row.issuerKey) ?? row.issuer }));
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
        change1wBp: null,
        change1mBp: null,
        ...NO_UPFRONT,
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

interface CdsSpreadLevel {
  spreadBp: number;
  date: string;
  change1wBp: number | null;
  change1mBp: number | null;
  quote: CdsQuote;
  upfrontPts: number | null;
  change1wPts: number | null;
  change1mPts: number | null;
  couponBp: number | null;
}

const NO_UPFRONT = { quote: "spread", upfrontPts: null, change1wPts: null, change1mPts: null, couponBp: null } as const;

/** The latest 5Y level, its date, its 1W and 1M moves and how it is quoted, by issuer key. */
export type CdsSpreadLevels = ReadonlyMap<string, CdsSpreadLevel>;

const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The backend's levels under the key the list groups issuers by, so every
 * spelling of a name finds its level. Where two names the backend keeps apart
 * fold into one key ("Oracle Corporation", "Oracle Cop"), the spelling the
 * list would show keeps it. Malformed entries are left out.
 */
export function spreadLevelsOf(levels: readonly CloudCdsLevelPayload[]): CdsSpreadLevels {
  const byKey = new Map<string, { issuer: string; level: CdsSpreadLevel }>();
  for (const level of levels) {
    if (typeof level.issuer !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(level.date) || !Number.isFinite(level.spreadBp)) continue;
    const issuer = displayIssuerName(level.issuer);
    if (!issuer) continue;
    const key = issuerGroupKey(issuer);
    const current = byKey.get(key);
    if (current && preferredIssuerName(current.issuer, issuer) === current.issuer) continue;
    const upfrontPts = finiteOrNull(level.upfrontPts);
    byKey.set(key, {
      issuer,
      level: {
        spreadBp: level.spreadBp,
        date: level.date,
        change1wBp: finiteOrNull(level.change1W),
        change1mBp: finiteOrNull(level.change1M),
        // A server before points upfront, or a level it could not convert, stays in bp.
        ...(level.quote === "upfront" && upfrontPts != null ? {
          quote: "upfront",
          upfrontPts,
          change1wPts: finiteOrNull(level.change1WPts),
          change1mPts: finiteOrNull(level.change1MPts),
          couponBp: finiteOrNull(level.couponBp),
        } : NO_UPFRONT),
      },
    });
  }
  return new Map([...byKey].map(([key, { level }]) => [key, level]));
}

/** Each issuer with the latest level of its 5Y line and its moves, where it has one, so the list ranks by them. */
export function withSpreadLevels(rows: readonly CdsIssuerSummary[], levels: CdsSpreadLevels | null): CdsIssuerSummary[] {
  if (!levels?.size) return [...rows];
  return rows.map((row) => {
    const level = levels.get(row.key);
    if (!level) return row;
    const { spreadBp, date, ...moves } = level;
    return { ...row, spread5yBp: spreadBp, spread5yDate: date, ...moves };
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
export function noTradesMessage({ query, issuer, days, unmatched = null }: {
  query: string | null;
  issuer: string | null;
  days: number;
  /**
   * A name that matched no covered issuer, once the tape has no trades and no
   * line under it either: what the view says instead is that no issuer
   * matches, with the covered ones closest to what was typed.
   */
  unmatched?: { nearest: readonly string[] } | null;
}): string {
  const window = `in the last ${days} days`;
  if (!query) return `No single-name CDS trades ${window}.`;
  if (unmatched) {
    const nearest = unmatched.nearest.length ? ` Closest covered issuers: ${unmatched.nearest.join(", ")}.` : "";
    return `No CDS issuer matches ${query}.${nearest}`;
  }
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

/** Points upfront to a tenth: `58.2 pts`. */
export function formatPoints(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${value.toFixed(1)} pts`;
}

/** A move in points upfront, signed as the bp moves are: `+10.9 pts`. */
export function formatPointsMove(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const rounded = Number(value.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${(rounded === 0 ? 0 : rounded).toFixed(1)} pts`;
}

/** A level in the unit it is quoted in. */
export function formatQuoted(unit: CdsQuoteUnit, value: number | null): string {
  return unit === "pts" ? formatPoints(value) : formatBp(value);
}

/** A 1W or 1M move in the unit its level is quoted in. */
export function formatQuotedMove(unit: CdsQuoteUnit, value: number | null): string {
  return unit === "pts" ? formatPointsMove(value) : formatSpreadMove(value);
}

/** A listed issuer's level and moves as quoted: bp, or points upfront for a name quoted upfront. */
export function quotedLevel(row: CdsIssuerSummary): {
  unit: CdsQuoteUnit;
  level: number | null;
  change1w: number | null;
  change1m: number | null;
} {
  return row.quote === "upfront"
    ? { unit: "pts", level: row.upfrontPts, change1w: row.change1wPts, change1m: row.change1mPts }
    : { unit: "bp", level: row.spread5yBp, change1w: row.change1wBp, change1m: row.change1mBp };
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

export type IssuerColumnId = "issuer" | "trades" | "last" | "spread" | "1w" | "1m";
export type IssuerColumn = DataTableColumn & { id: IssuerColumnId };
export type IssuerSortPreference = SortPreference<IssuerColumnId>;

export const ISSUER_SORT_COLUMN_IDS: readonly IssuerColumnId[] = ["issuer", "trades", "last", "spread", "1w", "1m"];
/** "Most active" is the reason the market-wide view exists. */
export const DEFAULT_ISSUER_SORT: IssuerSortPreference = { columnId: "trades", direction: "desc" };

/**
 * What `fn CDS --sort` ranks the list by, each largest first: the most
 * active, the widest, the widest move. By level or move, the names quoted in
 * bp come first, then those quoted in points, then those without one.
 */
export const ISSUER_LIST_SORTS = ["trades", "spread", "1w", "1m"] as const;

/** The list's order for a `--sort` value; an unknown one keeps the default. */
export function issuerListSort(value: unknown): IssuerSortPreference {
  return (ISSUER_LIST_SORTS as readonly unknown[]).includes(value)
    ? { columnId: value as (typeof ISSUER_LIST_SORTS)[number], direction: "desc" }
    : DEFAULT_ISSUER_SORT;
}

/**
 * The issuer takes the room the figures leave; the level and its moves sit as
 * the index board's do, under `5Y` since a name can be quoted in points.
 */
export function buildIssuerColumns(): IssuerColumn[] {
  return [
    { id: "issuer", label: "ISSUER", width: 16, align: "left", flexGrow: 1 },
    { id: "trades", label: "TRADES", width: 7, align: "right" },
    { id: "last", label: "LAST UTC", width: 16, align: "left" },
    { id: "spread", label: "5Y", width: 10, align: "right" },
    { id: "1w", label: "1W", width: 10, align: "right" },
    { id: "1m", label: "1M", width: 10, align: "right" },
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
      return quotedLevel(row).level;
    case "1w":
      return quotedLevel(row).change1w;
    case "1m":
      return quotedLevel(row).change1m;
  }
}

/** By level or move: bp first, then points (another unit), then none, whichever way the column sorts. */
function quoteGroup(columnId: IssuerColumnId, row: CdsIssuerSummary): number {
  if (columnId !== "spread" && columnId !== "1w" && columnId !== "1m") return 0;
  if (issuerSortValue(columnId, row) == null) return 2;
  return row.quote === "upfront" ? 1 : 0;
}

export function sortIssuers(
  rows: readonly CdsIssuerSummary[],
  sort: IssuerSortPreference,
): CdsIssuerSummary[] {
  const columnId = sort.columnId;
  if (!columnId) return [...rows];
  return [...rows].sort((left, right) => {
    const compared = quoteGroup(columnId, left) - quoteGroup(columnId, right) || compareSortValues(
      issuerSortValue(columnId, left),
      issuerSortValue(columnId, right),
      sort.direction,
    );
    // Stable secondary key so equal counts do not reshuffle between refreshes.
    return compared !== 0 ? compared : left.issuer.localeCompare(right.issuer);
  });
}

export type TradeColumnId = "time" | "maturity" | "notional" | "currency" | "coupon" | "spread" | "points" | "upfront";
export type TradeColumn = DataTableColumn & { id: TradeColumnId };
export type TradeSortPreference = SortPreference<TradeColumnId>;

export const DEFAULT_TRADE_SORT: TradeSortPreference = { columnId: "time", direction: "desc" };

/** Whether any print was quoted in points upfront, which is when the trades show a Points column. */
export function hasPointsQuotes(trades: readonly Pick<CdsTrade, "pointsUpfront">[]): boolean {
  return trades.some((trade) => trade.pointsUpfront != null);
}

/** The columns `]` and `[` cycle the trades' sort through: the ones shown. */
export function tradeSortColumnIds(points: boolean): readonly TradeColumnId[] {
  return ["time", "maturity", "notional", "coupon", "spread", ...(points ? ["points" as const] : []), "upfront"];
}

/** A Points column sits beside Spread only when a print was quoted in points. */
export function buildTradeColumns(width: number, points = false): TradeColumn[] {
  const maturityWidth = Math.max(10, Math.min(12, width - 59 - (points ? 9 : 0)));
  return [
    { id: "time", label: "TIME UTC", width: 16, align: "left" },
    { id: "maturity", label: "MATURITY", width: maturityWidth, align: "left" },
    { id: "notional", label: "NOTIONAL", width: 11, align: "right" },
    { id: "currency", label: "CCY", width: 5, align: "left" },
    { id: "coupon", label: "COUPON", width: 9, align: "right" },
    { id: "spread", label: "SPREAD", width: 10, align: "right" },
    ...(points ? [{ id: "points" as const, label: "POINTS", width: 9, align: "right" as const }] : []),
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
    case "points":
      return row.pointsUpfront;
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

/** The line's daily levels in the unit it is quoted in, dated at UTC midnight, with a break across a long gap. */
export function spreadChartPoints(points: readonly CdsQuotedPoint[]): TimeSeriesPoint[] {
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
    out.push({ date, observedAt: date, value: point.value });
    previous = time;
  }
  return out;
}

/** A 1W or 1M move as the index board shows one: `+36.7bp`, `--` without one. */
export function formatSpreadMove(value: number | null): string {
  return formatMove("spread", value);
}

/** An issuer's 5Y line as the server sends it: the daily levels, the latest one's moves and how it is quoted. */
export interface CdsSpreadLine {
  points: readonly CloudCdsHistoryPointPayload[];
  /** bp, on one contract and chained through the contract before across a roll; null unless the level is current. */
  change1W: number | null;
  change1M: number | null;
  quote: CdsQuote;
  /** Quoted upfront: the running coupon, the latest level in points and its moves in points. */
  couponBp: number | null;
  upfrontPts: number | null;
  change1WPts: number | null;
  change1MPts: number | null;
}

export interface CdsQuotedPoint {
  date: string;
  value: number;
}

/** Each day's level as the line is quoted: bp, or points upfront, leaving out a day the server could not convert. */
export function quotedPoints(line: CdsSpreadLine): CdsQuotedPoint[] {
  return line.quote === "upfront"
    ? line.points.flatMap((point) => (
      typeof point.upfrontPts === "number" && Number.isFinite(point.upfrontPts) ? [{ date: point.date, value: point.upfrontPts }] : []
    ))
    : line.points.map((point) => ({ date: point.date, value: point.spreadBp }));
}

/** The figures of an issuer's 5Y line, the ones the pane heads its chart with and a report carries. */
export interface CdsSpreadSummary {
  unit: CdsQuoteUnit;
  /** The latest level in that unit, and the New York trade date it is from. */
  level: number;
  date: string;
  /** The level is that day's settlement price, not its trades. */
  settlement: boolean;
  /** The same level in bp. */
  spreadBp: number;
  /** The running coupon of a name quoted upfront, bp. */
  couponBp: number | null;
  /** Its moves over a week and a month in that unit, through the roll; null unless the level is current. */
  change1w: number | null;
  change1m: number | null;
  /** Lowest and highest level in that unit since the first date charted; null with a single level. */
  range: { low: number; high: number; since: string } | null;
}

/**
 * The latest level, its 1W and 1M moves, and the range of what the chart
 * shows. The moves are the server's, by the index board's rule: on one
 * contract, and across the March and September rolls chained through the
 * contract before, which keeps trading off the run, so the roll to a contract
 * that trades wider is not a move. They are left out once the level is more
 * than 5 trading days behind the tape. Past 2,000bp all of it is in points
 * upfront.
 */
export function spreadSummary(line: CdsSpreadLine): CdsSpreadSummary | null {
  const latest = line.points.at(-1);
  if (!latest) return null;
  const upfront = line.quote === "upfront" && line.upfrontPts != null;
  const quoted = upfront ? quotedPoints(line) : line.points.map((point) => ({ date: point.date, value: point.spreadBp }));
  const values = quoted.map((point) => point.value);
  return {
    unit: upfront ? "pts" : "bp",
    level: upfront ? line.upfrontPts! : latest.spreadBp,
    date: latest.date,
    settlement: latest.kind === "settlement",
    spreadBp: latest.spreadBp,
    couponBp: upfront ? line.couponBp : null,
    change1w: upfront ? line.change1WPts : line.change1W,
    change1m: upfront ? line.change1MPts : line.change1M,
    range: quoted.length >= 2
      ? { low: Math.min(...values), high: Math.max(...values), since: quoted[0]!.date }
      : null,
  };
}

export type CdsNoLevelReason = "upfront-side-unknown";

/**
 * Why the view has no current 5Y level, in one line, when the server knows:
 * after the last level there is, or at all.
 */
export function noLevelMessage(reason: CdsNoLevelReason | null, lastLevel: string | null): string | null {
  if (reason !== "upfront-side-unknown") return null;
  return `5Y level not derivable${lastLevel ? ` after ${lastLevel}` : ""}: DTCC prints carry upfront without payer side`;
}

/** `129 to 276bp`, or `20.1 to 60.3 pts`: the low keeps the level's precision, so the level never falls outside it. */
export function formatSpreadRange(unit: CdsQuoteUnit, range: NonNullable<CdsSpreadSummary["range"]>): string {
  return unit === "pts"
    ? `${range.low.toFixed(1)} to ${formatPoints(range.high)}`
    : `${formatBp(range.low).slice(0, -2)} to ${formatBp(range.high)}`;
}

/** The pane's figures over its 5Y chart, from `spreadSummary`. */
export function spreadFigures(line: CdsSpreadLine): StatItem[] {
  const summary = spreadSummary(line);
  if (!summary) return [];
  const { unit } = summary;
  const dated = summary.settlement ? `${summary.date} · ${SETTLEMENT_TEXT}` : summary.date;
  return [
    unit === "pts"
      ? {
        id: "spread",
        label: "5Y upfront",
        value: formatPoints(summary.level),
        detail: summary.couponBp == null ? dated : `${dated} · ${formatBp(summary.couponBp)} coupon`,
      }
      : { id: "spread", label: "5Y spread", value: formatBp(summary.level), detail: dated },
    ...(summary.change1w != null ? [{ id: "1w", label: "1W", value: formatQuotedMove(unit, summary.change1w) }] : []),
    ...(summary.change1m != null ? [{ id: "1m", label: "1M", value: formatQuotedMove(unit, summary.change1m) }] : []),
    ...(summary.range ? [{
      id: "range",
      label: "Range",
      value: formatSpreadRange(unit, summary.range),
      detail: `since ${summary.range.since}`,
    }] : []),
  ];
}
