import type { AwardAggregate, AwardHistoryPoint, AwardRow, AwardType } from "../../../api-client/awards";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";

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

/** Concentration never compares a USD total to another currency or mixes subawards with prime awards. */
export function rankedAggregates(rows: readonly AwardAggregate[], currency: string, awardType: AwardType): AwardAggregate[] {
  return rows.filter((row) => (!currency || row.currency === currency) && row.awardType === awardType)
    .sort((a, b) => a.source.localeCompare(b.source) || a.currency.localeCompare(b.currency) || Number(b.obligatedAmount ?? b.awardAmount ?? 0) - Number(a.obligatedAmount ?? a.awardAmount ?? 0) || a.label.localeCompare(b.label));
}
