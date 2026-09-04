import type { DataTableColumn } from "../../../components";
import type { AnalystRatingRecord, AnalystResearchData } from "../../../types/financials";
import { formatCurrency, formatNumber } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";

function compactPeriod(period: string): string {
  return period
    .replace("current ", "")
    .replace("previous ", "prev ")
    .replace("next_", "next ")
    .replace(/_/g, " ");
}

export function targetUpside(target: AnalystResearchData["priceTarget"]): number | undefined {
  if (!target?.average || !target.current) return undefined;
  return (target.average - target.current) / target.current;
}

export function latestRecommendation(data: AnalystResearchData | null) {
  return data?.recommendations[0] ?? null;
}

export function recommendationTotal(data: AnalystResearchData | null): number {
  const rec = latestRecommendation(data);
  if (!rec) return 0;
  return (rec.strongBuy ?? 0) + (rec.buy ?? 0) + (rec.hold ?? 0) + (rec.sell ?? 0) + (rec.strongSell ?? 0);
}

export function formatRatingLabel(value: number | undefined): string {
  return value == null ? "-" : `${formatNumber(value, 1)}/10`;
}

export function formatPriceTarget(value: number | undefined, currency: string): string {
  if (value == null) return "-";
  return formatCurrency(value, currency)
    .replace(/\.00\b/, "")
    .replace(/(\.\d)0\b/, "$1");
}

const TARGET_SEPARATOR = " → ";

export interface RatingTargetColumnSizing {
  targetPriorWidth: number;
  targetCurrentWidth: number;
}

export function formatRatingTarget(
  row: AnalystResearchData["ratings"][number],
  currency: string,
  sizing?: Partial<RatingTargetColumnSizing>,
): string {
  const current = row.currentPriceTarget;
  const prior = row.priorPriceTarget;
  if (current == null && prior == null) return "-";
  if (current == null) return ` ${formatPriceTarget(prior, currency)}`;
  if (prior == null) return ` ${formatPriceTarget(current, currency)}`;

  const priorText = formatPriceTarget(prior, currency).padStart(sizing?.targetPriorWidth ?? 0);
  const currentText = formatPriceTarget(current, currency).padEnd(sizing?.targetCurrentWidth ?? 0);
  return ` ${priorText}${TARGET_SEPARATOR}${currentText}`;
}

export function ratingTargetDelta(row: AnalystResearchData["ratings"][number]): number | null {
  if (row.currentPriceTarget == null || row.priorPriceTarget == null) return null;
  return row.currentPriceTarget - row.priorPriceTarget;
}

export type RatingColumnId = "date" | "firm" | "action" | "current" | "target" | "prior";
export type RatingColumn = DataTableColumn & { id: RatingColumnId } & Partial<RatingTargetColumnSizing>;

export interface RatingSortPreference {
  columnId: RatingColumnId;
  direction: SortDirection;
}

export const DEFAULT_RATING_SORT: RatingSortPreference = {
  columnId: "date",
  direction: "desc",
};

const DEFAULT_RATING_SORT_DIRECTIONS: Record<RatingColumnId, SortDirection> = {
  date: "desc",
  firm: "asc",
  action: "asc",
  current: "asc",
  target: "desc",
  prior: "asc",
};

const BASE_RATING_COLUMNS: RatingColumn[] = [
  { id: "date", label: "DATE", width: 10, align: "left" },
  { id: "firm", label: "FIRM", width: 20, align: "left" },
  { id: "action", label: "ACTION", width: 10, align: "left" },
  { id: "current", label: "RATING", width: 13, align: "left" },
  { id: "target", label: "TARGET", width: 13, align: "left" },
  { id: "prior", label: "PRIOR", width: 13, align: "left" },
];

export function buildRatingColumns(
  rows: readonly AnalystRatingRecord[],
  currency: string,
): RatingColumn[] {
  const targetSizing = rows.reduce<RatingTargetColumnSizing>(
    (sizing, row) => ({
      targetPriorWidth: Math.max(
        sizing.targetPriorWidth,
        row.priorPriceTarget == null ? 0 : formatPriceTarget(row.priorPriceTarget, currency).length,
      ),
      targetCurrentWidth: Math.max(
        sizing.targetCurrentWidth,
        row.currentPriceTarget == null ? 0 : formatPriceTarget(row.currentPriceTarget, currency).length,
      ),
    }),
    { targetPriorWidth: 0, targetCurrentWidth: 0 },
  );
  const targetWidth = rows.reduce(
    (width, row) => Math.max(width, formatRatingTarget(row, currency, targetSizing).length),
    BASE_RATING_COLUMNS.find((column) => column.id === "target")?.width ?? 13,
  );

  return BASE_RATING_COLUMNS.map((column) => {
    return column.id === "target" ? { ...column, ...targetSizing, width: targetWidth } : column;
  });
}

function normalizedText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase() : null;
}

function ratingTargetSortValue(row: AnalystRatingRecord): number | null {
  return row.currentPriceTarget ?? row.priorPriceTarget ?? null;
}

function ratingSortValue(row: AnalystRatingRecord, columnId: RatingColumnId): string | number | null {
  switch (columnId) {
    case "date":
      return normalizedText(row.date);
    case "firm":
      return normalizedText(row.firm);
    case "action":
      return normalizedText(row.action);
    case "current":
      return normalizedText(row.current);
    case "target":
      return ratingTargetSortValue(row);
    case "prior":
      return normalizedText(row.prior);
  }
}

export function sortRatingRows<T extends AnalystRatingRecord>(
  rows: readonly T[],
  preference: RatingSortPreference,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const primary = compareSortValues(
        ratingSortValue(left.row, preference.columnId),
        ratingSortValue(right.row, preference.columnId),
        preference.direction,
      );
      if (primary !== 0) return primary;

      const dateTieBreak = preference.columnId === "date"
        ? 0
        : compareSortValues(
          ratingSortValue(left.row, "date"),
          ratingSortValue(right.row, "date"),
          "desc",
        );
      if (dateTieBreak !== 0) return dateTieBreak;

      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

export function nextRatingSortPreference(
  current: RatingSortPreference,
  columnId: string,
): RatingSortPreference {
  const typedColumnId = columnId as RatingColumnId;
  if (current.columnId !== typedColumnId) {
    return {
      columnId: typedColumnId,
      direction: DEFAULT_RATING_SORT_DIRECTIONS[typedColumnId] ?? "asc",
    };
  }
  return {
    columnId: typedColumnId,
    direction: current.direction === "asc" ? "desc" : "asc",
  };
}

export function buildAnalystSummaryLines(data: AnalystResearchData | null): string[] {
  if (!data) return [];

  const target = data.priceTarget;
  const currency = target?.currency ?? data.currency ?? "USD";
  const price = (value: number | undefined) => value != null ? formatCurrency(value, currency) : "-";
  const rec = latestRecommendation(data);
  const total = recommendationTotal(data);
  const lines: string[] = [];

  if (target) {
    lines.push(`low ${price(target.low)}   med ${price(target.median)}   high ${price(target.high)}`);
  }
  if (data.recommendationRating != null || rec || total > 0) {
    lines.push([
      data.recommendationRating != null ? `rating ${formatRatingLabel(data.recommendationRating)}` : null,
      rec ? `SB ${rec.strongBuy ?? 0}  B ${rec.buy ?? 0}  H ${rec.hold ?? 0}  S ${(rec.sell ?? 0) + (rec.strongSell ?? 0)}` : null,
      total > 0 ? `${total} analysts${rec?.period ? ` (${compactPeriod(rec.period)})` : ""}` : null,
    ].filter(Boolean).join("   "));
  }

  return lines;
}
