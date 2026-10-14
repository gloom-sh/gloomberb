import type { DataTableColumn, StatItem } from "../../../components";
import { spanDigits } from "../../../components/chart-table";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { formatCompact, formatNumber } from "../../../utils/format";
import { compareSortValues } from "../../../utils/sort-values";
import type { ShortInterestRecord } from "./types";

export type ShortInterestColumnId =
  | "settlementDate"
  | "sharesShort"
  | "shortRatio"
  | "averageDailyVolume"
  | "shortPercentFloat";

export type ShortInterestColumn = DataTableColumn & { id: ShortInterestColumnId };

export interface ShortInterestRow {
  key: string;
  record: ShortInterestRecord;
  settlementDate: string;
  sharesShort: string;
  shortRatio: string;
  averageDailyVolume: string;
  shortPercentFloat: string;
}

export interface SortPreference {
  columnId: ShortInterestColumnId;
  direction: "asc" | "desc";
}

export const DEFAULT_SORT: SortPreference = {
  columnId: "settlementDate",
  direction: "desc",
};

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatMaybeCompact(value: number | null): string {
  return value == null ? "-" : formatCompact(value);
}

function formatRatio(value: number | null): string {
  return value == null ? "-" : formatNumber(value, 2);
}

function formatPercent(value: number | null): string {
  return value == null ? "-" : `${formatNumber(value, 2)}%`;
}

const finiteNumber = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Shares short over the float, in percent. Short interest above the float is
 * possible (shares lent twice), twice it is not: such a float is another
 * class's (BRK.B's is Berkshire's Class A), so it is not used. The bound
 * Gloom Cloud's statistics use for their short % of float.
 */
function percentOfFloat(sharesShort: number, floatShares: number | null | undefined): number | null {
  return finiteNumber(floatShares) && floatShares > 0 && sharesShort <= floatShares * 2 ? (sharesShort / floatShares) * 100 : null;
}

/**
 * The statistics' short % of float (a fraction, null when not served) and the
 * settlement it is of: Gloom Cloud serves it on the float it serves, from the
 * settlement SI and SIW show, as the overview and `fundamentals` read it.
 */
export interface SettlementFloatStatistics {
  settlementDate: string;
  shortPercentOfFloat: number | null;
}

/**
 * A settlement's percent of float: the statistics' own when they are of the
 * same settlement, then a percentage the source states, then the shares short
 * over the current float.
 */
export function settlementPercentFloat(
  record: ShortInterestRecord,
  floatShares: number | null | undefined,
  statistics?: SettlementFloatStatistics | null,
): number | null {
  if (statistics && statistics.settlementDate === record.settlementDate.toISOString().slice(0, 10)) {
    return finiteNumber(statistics.shortPercentOfFloat) ? statistics.shortPercentOfFloat * 100 : null;
  }
  return record.shortPercentFloat ?? percentOfFloat(record.sharesShort, floatShares);
}

/**
 * The newest settlement's percent of float where the source gives none, read
 * against the current float as SIW reads it (settlementPercentFloat). The
 * float is undated, so the settlements before it stay blank rather than take
 * today's float.
 */
export function withLatestPercentFloat(
  records: readonly ShortInterestRecord[],
  floatShares: number | null | undefined,
  statistics?: SettlementFloatStatistics | null,
): ShortInterestRecord[] {
  const latest = records.reduce<ShortInterestRecord | null>(
    (best, record) => (!best || record.settlementDate.getTime() > best.settlementDate.getTime() ? record : best),
    null,
  );
  return records.map((record) => (record === latest
    ? { ...record, shortPercentFloat: settlementPercentFloat(record, floatShares, statistics) }
    : record));
}

export function buildRows(records: ShortInterestRecord[]): ShortInterestRow[] {
  return records.map((record, index) => ({
    key: `${record.settlementDate.toISOString()}:${index}`,
    record,
    settlementDate: formatDate(record.settlementDate),
    sharesShort: formatMaybeCompact(record.sharesShort),
    shortRatio: formatRatio(record.shortRatio),
    averageDailyVolume: formatMaybeCompact(record.averageDailyVolume),
    shortPercentFloat: formatPercent(record.shortPercentFloat),
  }));
}

function sortValue(row: ShortInterestRow, columnId: ShortInterestColumnId): string | number | null {
  switch (columnId) {
    case "settlementDate":
      return row.record.settlementDate.getTime();
    case "sharesShort":
      return row.record.sharesShort;
    case "shortRatio":
      return row.record.shortRatio;
    case "averageDailyVolume":
      return row.record.averageDailyVolume;
    case "shortPercentFloat":
      return row.record.shortPercentFloat;
  }
}

export function sortRows(rows: ShortInterestRow[], preference: SortPreference): ShortInterestRow[] {
  return [...rows].sort((a, b) =>
    compareSortValues(sortValue(a, preference.columnId), sortValue(b, preference.columnId), preference.direction),
  );
}

/**
 * The columns sit together rather than spread across the pane, so the figures
 * of one settlement read as a row, and fit a 60-column pane without a
 * horizontal scrollbar. FINRA settlement history carries no float, so percent of float
 * is null for every row unless the latest one is read against the current float
 * (`withLatestPercentFloat`). Keeping the column with nothing in it drew a header over a
 * column of dashes, which reads as missing data rather than data the source never had.
 */
export function buildColumns(
  records: readonly ShortInterestRecord[] = [],
): ShortInterestColumn[] {
  const hasPercentFloat = records.some((record) => record.shortPercentFloat != null);
  const dateWidth = 12;
  const sharesWidth = 12;
  const ratioWidth = 12;
  const percentWidth = 10;
  return [
    { id: "settlementDate", label: "DATE", width: dateWidth, align: "left" },
    { id: "sharesShort", label: "SHARES SHORT", width: sharesWidth, align: "right" },
    { id: "shortRatio", label: "DAYS TO COVER", width: ratioWidth, align: "right" },
    { id: "averageDailyVolume", label: "AVG VOL", width: 11, align: "right" },
    ...(hasPercentFloat
      ? [{ id: "shortPercentFloat" as const, label: "% FLOAT", width: percentWidth, align: "right" as const }]
      : []),
  ];
}

const SHARE_UNITS = [[1e9, "B"], [1e6, "M"], [1e3, "k"]] as const;

/**
 * Share counts on the chart axis, compact with the decimals the plotted range
 * needs, so 114M to 118M reads 114.5M / 115.0M rather than 115M twice.
 */
export function formatSharesAxis(value: number, domain: Pick<CompositeAxisDomain, "min" | "max">): string {
  const magnitude = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  const [divisor, suffix] = SHARE_UNITS.find(([unit]) => magnitude >= unit) ?? [1, ""];
  const digits = spanDigits({ min: domain.min / divisor, max: domain.max / divisor });
  return `${(value / divisor).toFixed(digits)}${suffix}`;
}

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : text;
}

/**
 * The latest settlement's figures, most important first: the level with its
 * settlement date, days to cover, percent of float when the source has one,
 * and the move since the settlement before.
 */
export function shortInterestFigures(records: readonly ShortInterestRecord[]): StatItem[] {
  const sorted = [...records].sort((left, right) => left.settlementDate.getTime() - right.settlementDate.getTime());
  const latest = sorted.at(-1);
  if (!latest) return [];
  const prior = sorted.at(-2);
  const change = prior && prior.sharesShort > 0 ? latest.sharesShort - prior.sharesShort : null;
  return [
    { id: "shares", label: "Shares short", value: formatMaybeCompact(latest.sharesShort), detail: formatDate(latest.settlementDate) },
    ...(latest.shortRatio != null ? [{ id: "days", label: "Days to cover", value: formatRatio(latest.shortRatio) }] : []),
    ...(latest.shortPercentFloat != null ? [{ id: "float", label: "% float", value: formatPercent(latest.shortPercentFloat) }] : []),
    ...(change != null && prior ? [{
      id: "change",
      label: "Change",
      value: signed(change, `${formatNumber((change / prior.sharesShort) * 100, 1)}%`),
      // The prior settlement is the table's next row, so its date is not repeated.
      detail: signed(change, formatCompact(change)),
    }] : []),
  ];
}
