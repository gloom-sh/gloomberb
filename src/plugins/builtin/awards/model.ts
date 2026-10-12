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
  if (value == null) return "--";
  const amount = Number(value), absolute = Math.abs(amount);
  for (const [scale, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (absolute >= scale) return `${(amount / scale).toFixed(2)}${suffix}`;
  }
  return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export const awardPeriod = (row: AwardRow) => row.periodStart || row.periodEnd ? `${row.periodStart ?? "--"} / ${row.periodEnd ?? "--"}` : "--";
export const awardPercent = (row: AwardRow) => row.revenueComparison ? `${row.revenueComparison.percent.toFixed(2)}%` : "--";
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
