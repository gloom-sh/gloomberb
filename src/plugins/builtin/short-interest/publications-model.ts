import type { DataTableColumn } from "../../../components";
import { formatCompactAxis, formatPercentAxis, spanAxisFormatter } from "../../../components/chart-table/axis";
import type { CompositeAxisValueFormatter } from "../../../components/chart/composite/format";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { HeadlessPaneColumn } from "../../../types/plugin";
import type { PublicationKind, PublicationPayload } from "./publications-client";
import { MISSING_VALUE, formatCompact } from "../../../utils/format";
import { formatDay } from "../../../components/ui/day-cell";

export interface PublicationRow {
  id: string;
  date: string;
  sourceUrl: string;
  [key: string]: string | number | null;
}
export interface PublicationColumn extends DataTableColumn {
  detailLabel: string;
  format?: (value: string | number | null) => string;
}
const shares = (value: string | number | null) => value == null ? MISSING_VALUE : formatCompact(Number(value), { fixedDecimals: true });
const percentage = (value: string | number | null) => value == null ? MISSING_VALUE : `${Number(value).toFixed(2)}%`;
const price = (value: string | number | null) => value == null ? MISSING_VALUE : `$${Number(value).toFixed(2)}`;
const day = (value: string | number | null) => formatDay(value);
const FTD_COLUMNS: PublicationColumn[] = [
  { id: "date", label: "SETTLEMENT", detailLabel: "Settlement date", width: 12, align: "left", format: day },
  { id: "quantity", label: "FAIL SHARES", detailLabel: "Outstanding fail shares", width: 14, align: "right", format: shares },
  { id: "cusip", label: "CUSIP", detailLabel: "CUSIP", width: 11, align: "left" },
  { id: "price", label: "PRICE (USD)", detailLabel: "Reported price (USD)", width: 13, align: "right", format: price },
  { id: "description", label: "SECURITY", detailLabel: "Security", width: 20, flexGrow: 1, align: "left" },
];
const ATS_COLUMNS: PublicationColumn[] = [
  { id: "date", label: "WEEK OF", detailLabel: "Week starting", width: 12, align: "left", format: day },
  { id: "atsShares", label: "ATS SHARES", detailLabel: "ATS shares", width: 14, align: "right", format: shares },
  { id: "nonAtsShares", label: "NON-ATS SHARES", detailLabel: "Non-ATS shares", width: 16, align: "right", format: shares },
  { id: "atsSharePercent", label: "ATS %", title: "ATS shares / published ATS plus non-ATS shares (%)", detailLabel: "ATS %", width: 14, align: "right", format: percentage },
  { id: "totalShares", label: "TOTAL SHARES", detailLabel: "Total off-exchange shares", width: 14, align: "right", format: shares },
  { id: "atsTrades", label: "ATS TRADES", detailLabel: "ATS trades", width: 14, align: "right", format: shares },
  { id: "nonAtsTrades", label: "NON-ATS TRADES", detailLabel: "Non-ATS trades", width: 16, align: "right", format: shares },
];
/**
 * What every fail row names: one CUSIP and one security, as a ticker with a
 * single issue has. A shared value is said once above the table (and in the
 * export's notes), not on every row; a ticker with several CUSIPs, or a
 * security the filings spell differently over time, keeps the column.
 */
interface FailIdentity {
  cusip: string | null;
  security: string | null;
}
const NO_IDENTITY: FailIdentity = { cusip: null, security: null };
export function sharedFailIdentity(rows: readonly PublicationRow[]): FailIdentity {
  const shared = (id: "cusip" | "description"): string | null => {
    const values = new Set(rows.map((row) => row[id]));
    const [value] = values;
    return values.size === 1 && typeof value === "string" && value.trim() ? value : null;
  };
  return rows.length ? { cusip: shared("cusip"), security: shared("description") } : NO_IDENTITY;
}
export const publicationColumns = (kind: PublicationKind, shared: FailIdentity = NO_IDENTITY) => kind === "ftd"
  ? FTD_COLUMNS.filter((column) => !(column.id === "cusip" && shared.cusip) && !(column.id === "description" && shared.security))
  : ATS_COLUMNS;
export function publicationRows(data: PublicationPayload): PublicationRow[] {
  return data.history.toReversed().map((row) => "cusip" in row
    ? { ...row, id: `${row.date}:${row.cusip}` }
    : { ...row, id: row.weekStart, date: row.weekStart });
}
export const publicationCell = (column: PublicationColumn, value: string | number | null) =>
  column.format ? column.format(value) : String(value ?? MISSING_VALUE);

/** Fewer points than this are no trend: the band is left to the table. */
const CHART_MIN_POINTS = 3;
const FAIL_SHARES = "fail-shares";
const FAIL_PRICE = "fail-price";
const ATS_PERCENT = "ats-percent";

/**
 * The chart over a tab's table, oldest first. Fails to deliver: the fail
 * shares of each settlement date as columns against the price the same rows
 * report, on an axis of its own, for one issue only (several CUSIPs' fails are
 * different securities and are never added). Weekly ATS/OTC: the ATS share of
 * off-exchange shares by week. Each series is named as its table column is.
 */
export function publicationChartSeries(
  kind: PublicationKind,
  rows: readonly PublicationRow[],
  palette: { warning: string; text: string },
): ResolvedSeries[] {
  const oldest = rows.toReversed();
  const at = (row: PublicationRow) => new Date(`${row.date}T00:00:00Z`);
  const number = (value: string | number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  if (kind === "ats") {
    const points = oldest.map((row) => scalarPoint(at(row), number(row.atsSharePercent)));
    if (points.filter((point) => point.value != null).length < CHART_MIN_POINTS) return [];
    return [{ ...staticSeries(points, { id: "ats-percent", label: "ATS %", color: palette.warning, calendarSpaced: true }), unit: "%", unitGroup: ATS_PERCENT }];
  }
  if (sharedFailIdentity(rows).cusip == null || rows.length < CHART_MIN_POINTS) return [];
  const fails: ResolvedSeries = {
    ...staticSeries(oldest.map((row) => scalarPoint(at(row), number(row.quantity))),
      { id: "fail-shares", label: "Fail shares", color: palette.warning, style: "columns", calendarSpaced: true }),
    unit: "shares", unitGroup: FAIL_SHARES, axis: "left",
  };
  const prices = oldest.map((row) => scalarPoint(at(row), number(row.price)));
  const price: ResolvedSeries = {
    ...staticSeries(prices, { id: "price", label: "Price", color: palette.text, calendarSpaced: true }),
    unit: "USD", unitGroup: FAIL_PRICE, axis: "right",
  };
  return prices.filter((point) => point.value != null).length >= 2 ? [fails, price] : [fails];
}

/** A legend value in its table column's words: `224.7k` fail shares, `$347.73`, `41.54%`. */
export function publicationChartValue(value: number, series?: Pick<ResolvedSeries, "unitGroup">): string {
  if (series?.unitGroup === FAIL_PRICE) return price(value);
  if (series?.unitGroup === ATS_PERCENT) return percentage(value);
  return formatCompact(value);
}

const priceAxis = spanAxisFormatter((value, digits) => `$${value.toFixed(digits)}`, 2);

/**
 * Each axis in its own unit: fail shares compact (`600k`), the price in
 * dollars, the ATS share in percent; the crosshair's tag reads as the table
 * does: fail shares `224.7k` (or `8`, never `0k`), the price to the cent, the
 * percent to the hundredth.
 */
export const publicationAxisValue: CompositeAxisValueFormatter = Object.assign(
  (value: number, domain: CompositeAxisDomain) => domain.unitGroup === FAIL_PRICE ? priceAxis(value, domain)
    : domain.unitGroup === ATS_PERCENT ? formatPercentAxis(value, domain) : formatCompactAxis(value, domain),
  {
    tag: (value: number, domain: CompositeAxisDomain) => domain.unitGroup === FAIL_PRICE ? priceAxis.tag!(value, domain)
      : domain.unitGroup === ATS_PERCENT ? formatPercentAxis.tag!(value, domain) : formatCompact(value),
  },
);
/** Reports retain exact quantities; compact display values are never the exported data. */
export function publicationReportColumns(kind: PublicationKind): HeadlessPaneColumn[] {
  return publicationColumns(kind).map((column) => ({
    key: column.id, header: column.detailLabel, align: column.align,
    ...(column.id === "atsSharePercent" ? { format: (value: unknown) => percentage(value as number | null) } : {}),
  }));

}
