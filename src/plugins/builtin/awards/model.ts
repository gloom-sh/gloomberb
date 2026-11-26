import { MISSING_VALUE } from "../../../utils/format";
import { formatDay } from "../../../components/ui/day-cell";
import type { AwardAggregate, AwardFilter, AwardHistoryPoint, AwardRow, AwardsPayload, AwardType } from "../../../api-client/awards";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import { freePreviewNote, previewCantFilter } from "../shared/free-preview";

export const AWARD_TABS = [{ value: "feed", label: "Feed" }, { value: "company", label: "Company" },
  { value: "agencies", label: "Agencies" }, { value: "sectors", label: "Sectors" }, { value: "events", label: "Events" }] as const;
export type AwardTab = typeof AWARD_TABS[number]["value"];
export const awardTab = (value: unknown): AwardTab => AWARD_TABS.find((tab) => tab.value === value)?.value ?? "feed";
export const awardTypeLabel = (value: AwardType) => ({ prime: "Prime", subaward: "Subaward", modification: "Modification", notice: "Notice" })[value];
export function money(value: string | number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  const amount = Number(value), absolute = Math.abs(amount);
  for (const [scale, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (absolute >= scale) return `${(amount / scale).toFixed(2)}${suffix}`;
  }
  return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export const awardPeriod = (row: AwardRow) => row.periodStart || row.periodEnd ? `${formatDay(row.periodStart)} / ${formatDay(row.periodEnd)}` : MISSING_VALUE;
/** The period as exports write it: ISO days. */
export const awardPeriodValue = (row: AwardRow) => row.periodStart || row.periodEnd ? `${row.periodStart ?? ""} / ${row.periodEnd ?? ""}` : null;
export const awardPercent = (row: AwardRow) => row.revenueComparison ? `${row.revenueComparison.percent.toFixed(2)}%` : MISSING_VALUE;
export const aggregateId = (row: AwardAggregate) => JSON.stringify([row.key, row.source, row.currency, row.awardType]);
const historyDate = (row: AwardHistoryPoint) => new Date(`${row.month.slice(0, 7)}-01T00:00:00Z`);
export const awardScope = (source: string) => ({ usaspending: "US federal contracts", "usaspending-subawards": "US federal subcontracts", "usaspending-transactions": "US contract actions", "uk-contracts-finder": "UK contract notices",
  "uk-find-tender": "UK tender notices", ted: "EU notices", "ca-contracts": "Canadian federal contracts", dod: "US defense announcements", sam: "US federal opportunities" })[source] ?? "Public contract notices";

/** Retrospective award cohorts use one currency and one record type. No transaction flow or FX inference. */
export function awardHistorySeries(points: readonly AwardHistoryPoint[], source: string, currency: string, awardType: AwardType, colors: [string, string]): ResolvedSeries[] {
  const rows = points.filter((row) => row.source === source && row.currency === currency && row.awardType === awardType).sort((a, b) => a.month.localeCompare(b.month));
  const measures = [{ key: "cumulativeObligatedAmount", label: "Cumulative awarded obligations", color: colors[0] },
    { key: "obligatedAmount", label: "Awarded obligations", color: colors[1] }] as const;
  return measures.flatMap(({ key, label, color }) => {
    const values = rows.filter((row) => row[key] !== null);
    if (values.length < 3) return [];
    return [{ ...staticSeries(rows.map((row) => ({ date: historyDate(row), observedAt: historyDate(row), value: row[key] === null ? null : Number(row[key]) })),
      { id: key, label, color, style: key === "cumulativeObligatedAmount" ? "step" : "columns", calendarSpaced: true }), unit: currency, unitGroup: `awards:${currency}`, interpolation: key === "cumulativeObligatedAmount" ? "step-after" : "none" }];
  });
}

const FILTER_NAMES: [keyof AwardFilter, string][] = [["ticker", "ticker"], ["parentId", "contract"], ["jurisdiction", "country"], ["agency", "agency"],
  ["sector", "sector"], ["source", "scope"], ["currency", "currency"], ["from", "date"], ["to", "date"], ["fiscalYear", "fiscal year"], ["query", "search"], ["minAmount", "amount"]];

/**
 * What a free preview leaves unapplied: the server answers every free request
 * with the same latest awards, so none of these narrow it. Prime is the
 * default type, not a choice.
 */
function previewIgnoredFilters(filter: AwardFilter): string[] {
  const names = FILTER_NAMES.filter(([key]) => filter[key] != null && filter[key] !== "").map(([, name]) => name);
  return [...new Set([...names, ...(filter.awardType && filter.awardType !== "prime" ? ["type"] : [])])];
}

/** "ticker", "ticker and country": the filters Pro would apply. */
const filterList = (names: readonly string[]) => names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** The lock line of a free preview, in the same words in the pane, `fn AWARDS` and its JSON. */
/** The one country a source publishes awards of; EU notices (TED) name many, and are in none. */
const SOURCE_COUNTRY: Record<string, string> = { usaspending: "US", "usaspending-subawards": "US", "usaspending-transactions": "US", dod: "US", sam: "US",
  "uk-contracts-finder": "GB", "uk-find-tender": "GB", "ca-contracts": "CA" };

/** What every award a feed query lists shares, so the feed says it once rather than on each row. */
export interface AwardsQueryShared { ticker: string | null; currency: string | null; country: string | null }

/**
 * What every award of a feed query shares, whichever page is loaded: the ticker
 * and the currency and country it is filtered to, and else the one currency
 * and country its agency totals name, which cover the whole query unless they
 * are cut short. A preview applies no filter and has no totals of the query,
 * so it shares nothing.
 */
export function awardsQueryShared(data: AwardsPayload | null | undefined, filter: Pick<AwardFilter, "ticker" | "currency" | "jurisdiction">): AwardsQueryShared {
  if (!data || data.locked || data.access !== "full") return { ticker: null, currency: null, country: null };
  const totals = data.truncated?.agencies || data.agencies.length === 0 ? null : data.agencies;
  const one = (values: readonly (string | undefined)[]) => {
    const distinct = new Set(values);
    return distinct.size === 1 ? [...distinct][0] ?? null : null;
  };
  const rowsAgree = (value: string | null, pick: (row: AwardRow) => string) => value && data.rows.every((row) => pick(row) === value) ? value : null;
  return {
    ticker: filter.ticker || null,
    currency: filter.currency || rowsAgree(totals ? one(totals.map((row) => row.currency)) : null, (row) => row.currency),
    country: filter.jurisdiction || rowsAgree(totals ? one(totals.map((row) => SOURCE_COUNTRY[row.source])) : null, (row) => row.jurisdiction),
  };
}

/** An amount column's header once the feed shares one currency: `Obligated USD`. */
export const awardAmountLabel = (label: string, currency: string | null) => currency ? `${label} ${currency}` : label;

export function awardsPreviewNote(data: AwardsPayload, filter: AwardFilter): string | null {
  if (!data.locked) return null;
  const ignored = previewIgnoredFilters(filter);
  const count = data.rows.length;
  const rows = count === 0 ? "no awards" : count === 1 ? "the latest award" : `the ${count.toLocaleString("en-US")} latest awards`;
  // Pro's history starts where the earliest collected source does.
  const historyFrom = data.sources.filter((source) => source.records > 0 && source.coverageStart).map((source) => source.coverageStart!).sort()[0] ?? null;
  return freePreviewNote({
    shows: ignored.length ? `${rows}${ignored.includes("ticker") ? " from any company" : ""}: ${previewCantFilter(ignored)}` : rows,
    adds: ignored.length ? `${filterList(ignored)} filters and every collected award` : "every collected award and filters",
    historyFrom,
  });
}

/** The server's word for a selection with no awards: the report's empty line, not a gap in coverage. */
const NO_AWARDS = "No awards are available for this selection.";

/** Why the awards asked for are empty, as the server says it; null while there are some. */
export function awardsEmptyReason(data: Pick<AwardsPayload, "gaps">): string | null {
  return data.gaps.includes(NO_AWARDS) ? NO_AWARDS : null;
}

/**
 * Collection health (jurisdictions awaiting a first collection, unfinished
 * windows, quarantined records, a paused or capped store): what the awards
 * shown may be missing, so coverage notes in the pane, `fn AWARDS` and its
 * JSON, never errors.
 */
export function awardsCoverageNotes(data: Pick<AwardsPayload, "gaps">): string[] {
  return data.gaps.filter((gap) => gap !== NO_AWARDS);
}

/**
 * The statements the licences of the sources shown ask for wherever their
 * data is shown, each once, in the server's source order: the pane, the
 * award's detail and `fn AWARDS` print them under the awards they cover.
 */
export function awardsAttributions(data: Pick<AwardsPayload, "sources"> | undefined, shown: Iterable<string>): string[] {
  return sourceStatements(data, shown, "attribution");
}

/**
 * How the amounts of the sources shown read, each once: GeBIZ's says it
 * withholds an amount under S$6,000 or one that several suppliers of a tender
 * print alike. The award's detail and `fn AWARDS` print them beside a
 * withheld value.
 */
export function awardsAmountNotices(data: Pick<AwardsPayload, "sources"> | undefined, shown: Iterable<string>): string[] {
  return sourceStatements(data, shown, "amountNotice");
}

function sourceStatements(data: Pick<AwardsPayload, "sources"> | undefined, shown: Iterable<string>, key: "attribution" | "amountNotice"): string[] {
  const sources = new Set(shown);
  return [...new Set((data?.sources ?? []).flatMap((source) => {
    const statement = source[key];
    return sources.has(source.source) && typeof statement === "string" && statement.trim() ? [statement.trim()] : [];
  }))];
}

/** What an award's value reads when its source withholds it, never 0 and never the unreported mark. */
export const WITHHELD_AMOUNT = "withheld";

/**
 * Why an award's value is withheld by its source rather than unreported, or
 * null: the award's own reason (GeBIZ's "under S$6,000"), never its source's,
 * so an amount the source never printed still reads unreported.
 */
export function amountWithheld(row: Pick<AwardRow, "awardAmount" | "amountWithheld">): string | null {
  const why = row.amountWithheld;
  return row.awardAmount == null && typeof why === "string" && why.trim() ? why.trim() : null;
}

/** A source's statement as served, or nothing: an older or malformed answer's non-string is never read as one. */
export function statementText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Award dates after the response's own date are the source's, not a mapping slip; they say so instead of passing as past awards. */
export function futureAwardDatesNote(rows: readonly AwardRow[], generatedAt: string): string | null {
  const today = generatedAt.slice(0, 10);
  const count = rows.filter((row) => (row.dateBasis ?? "award") === "award" && row.awardDate > today).length;
  if (!count) return null;
  return `${count === 1 ? "1 award date is" : `${count} award dates are`} after today, as the source published ${count === 1 ? "it" : "them"}.`;
}

/** Concentration never compares a USD total to another currency or mixes subawards with prime awards. */
export function rankedAggregates(rows: readonly AwardAggregate[], currency: string, awardType: AwardType): AwardAggregate[] {
  return rows.filter((row) => (!currency || row.currency === currency) && row.awardType === awardType)
    .sort((a, b) => a.source.localeCompare(b.source) || a.currency.localeCompare(b.currency) || Number(b.obligatedAmount ?? b.awardAmount ?? 0) - Number(a.obligatedAmount ?? a.awardAmount ?? 0) || a.label.localeCompare(b.label));
}
