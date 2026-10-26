import type { DataTableColumn, StatItem } from "../../../components";
import { spanDigits } from "../../../components/chart-table";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { formatCompact, formatNumber } from "../../../utils/format";
import { compareSortValues } from "../../../utils/sort-values";
import { shortInterestPublished } from "./schedule";
import type { ShortInterestRecord } from "./types";

export type ShortInterestColumnId =
  | "settlementDate"
  | "publishedDate"
  | "floatAsOf"
  | "sharesShort"
  | "shortRatio"
  | "averageDailyVolume"
  | "shortPercentFloat";

export type ShortInterestColumn = DataTableColumn & { id: ShortInterestColumnId };

export interface ShortInterestRow {
  key: string;
  record: ShortInterestRecord;
  settlementDate: string;
  /** When FINRA published the settlement, `YYYY-MM-DD`; `-` when the date is not one. */
  publishedDate: string;
  /** The day of the share count the percent of float is read on; `-` when it is undated or there is none. */
  floatAsOf: string;
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

/** The float a percent of float is read against today, and the share count it floats out of. */
export interface CurrentFloat {
  floatShares: number | null | undefined;
  /** YYYY-MM-DD the float was counted, when it is dated (the statistics' `floatSharesAsOf`); a source's own float is not. */
  floatAsOf?: string | null;
  /** The share count the float is held within (the statistics' shares outstanding). */
  sharesOutstanding?: number | null;
  statistics?: SettlementFloatStatistics | null;
}

/**
 * Each settlement's percent of float where the source gives none. The newest
 * is read against the current float, as SIW and the statistics read it
 * (settlementPercentFloat). An earlier one is read against the float of its
 * own day: the 10-K or 10-Q share count known when FINRA published it
 * (`sharesOutstanding` on the record) times the part of today's count that
 * floats. A settlement without such a count stays blank rather than take
 * today's float. `pointInTime` reads the newest the same way, so a report
 * cut at a date (`--as-of`) uses no count filed after its settlements.
 */
export function withPercentFloat(
  records: readonly ShortInterestRecord[],
  current: CurrentFloat,
  { pointInTime = false }: { pointInTime?: boolean } = {},
): ShortInterestRecord[] {
  const latest = pointInTime ? null : records.reduce<ShortInterestRecord | null>(
    (best, record) => (!best || record.settlementDate.getTime() > best.settlementDate.getTime() ? record : best),
    null,
  );
  const { floatShares, sharesOutstanding } = current;
  const floating = finiteNumber(floatShares) && finiteNumber(sharesOutstanding) && floatShares > 0 && sharesOutstanding > 0
    ? Math.min(1, floatShares / sharesOutstanding) : null;
  return records.map((record) => {
    if (record === latest) {
      const percent = settlementPercentFloat(record, floatShares, current.statistics);
      return { ...record, shortPercentFloat: percent, floatAsOf: percent != null ? current.floatAsOf ?? null : null };
    }
    if (record.shortPercentFloat != null || floating == null || !finiteNumber(record.sharesOutstanding)) return record;
    return {
      ...record,
      shortPercentFloat: percentOfFloat(record.sharesShort, record.sharesOutstanding * floating),
      floatAsOf: record.sharesOutstandingAsOf ?? null,
    };
  });
}

export function buildRows(records: ShortInterestRecord[]): ShortInterestRow[] {
  return records.map((record, index) => ({
    key: `${record.settlementDate.toISOString()}:${index}`,
    record,
    settlementDate: formatDate(record.settlementDate),
    publishedDate: shortInterestPublished(formatDate(record.settlementDate)) ?? "-",
    floatAsOf: record.shortPercentFloat != null && record.floatAsOf ? record.floatAsOf : "-",
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
    case "publishedDate":
      return row.publishedDate === "-" ? null : row.publishedDate;
    case "floatAsOf":
      return row.floatAsOf === "-" ? null : row.floatAsOf;
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
 * of one settlement read as a row: when it settled, when FINRA published it
 * (what a trader could see that day), then its figures. FINRA settlement
 * history carries no float, so percent of float is null for every row unless
 * it is read against a float (`withPercentFloat`), dated where that float is:
 * an earlier settlement's by the count it is read on. Keeping the column with nothing in it drew a
 * header over a column of dashes, which reads as missing data rather than
 * data the source never had.
 */
export function buildColumns(
  records: readonly ShortInterestRecord[] = [],
): ShortInterestColumn[] {
  const hasPercentFloat = records.some((record) => record.shortPercentFloat != null);
  const hasFloatDate = records.some((record) => record.shortPercentFloat != null && !!record.floatAsOf);
  const dateWidth = 11;
  const sharesWidth = 12;
  const ratioWidth = 12;
  const percentWidth = 9;
  return [
    { id: "settlementDate", label: "DATE", width: dateWidth, align: "left" },
    { id: "publishedDate", label: "PUBLISHED", width: dateWidth, align: "left" },
    { id: "sharesShort", label: "SHARES SHORT", width: sharesWidth, align: "right" },
    { id: "shortRatio", label: "DAYS TO COVER", width: ratioWidth, align: "right" },
    { id: "averageDailyVolume", label: "AVG VOL", width: 11, align: "right" },
    ...(hasPercentFloat
      ? [{ id: "shortPercentFloat" as const, label: "% FLOAT", width: percentWidth, align: "right" as const }]
      : []),
    ...(hasFloatDate
      ? [{ id: "floatAsOf" as const, label: "FLOAT AS OF", width: dateWidth + 1, align: "right" as const }]
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
    ...(latest.shortPercentFloat != null ? [{
      id: "float",
      label: "% float",
      value: formatPercent(latest.shortPercentFloat),
      ...(latest.floatAsOf ? { detail: `as of ${latest.floatAsOf}` } : {}),
    }] : []),
    ...(change != null && prior ? [{
      id: "change",
      label: "Change",
      value: signed(change, `${formatNumber((change / prior.sharesShort) * 100, 1)}%`),
      // The prior settlement is the table's next row, so its date is not repeated.
      detail: signed(change, formatCompact(change)),
    }] : []),
  ];
}
