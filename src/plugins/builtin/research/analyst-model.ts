import type { DataTableColumn, PaneFooterSegment } from "../../../components";
import type { AnalystRatingRecord, AnalystResearchData } from "../../../types/financials";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { formatRelativeTime } from "../../../utils/datetime-format";
import { displayWidth, formatCurrency, formatNumber } from "../../../utils/format";
import { compareSortValues, type SortDirection } from "../../../utils/sort-values";
import { loadingErrorFooterInfo } from "../shared/table-pane";

function compactPeriod(period: string): string {
  return period
    .replace("current ", "")
    .replace("previous ", "prev ")
    .replace("next_", "next ")
    .replace(/_/g, " ");
}

export function targetUpside(target: AnalystResearchData["priceTarget"]): number | undefined {
  if (target?.average == null || target.current == null
    || !Number.isFinite(target.average) || !Number.isFinite(target.current)
    || target.average < 0 || target.current <= 0) return undefined;
  return (target.average - target.current) / target.current;
}

function isCurrentMonthPeriod(period: string | undefined): boolean {
  return ["current month", "0m"].includes((period ?? "").trim().toLowerCase().replace(/_/g, " "));
}

export function latestRecommendation(data: AnalystResearchData | null) {
  const rows = data?.recommendations ?? [];
  return rows.find((row) => isCurrentMonthPeriod(row.period)) ?? rows[0] ?? null;
}

function recommendationCount(value: number | undefined): number | null {
  return value != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function recommendationMix(data: AnalystResearchData | null) {
  const rec = latestRecommendation(data);
  return rec ? {
    period: rec.period,
    strongBuy: recommendationCount(rec.strongBuy),
    buy: recommendationCount(rec.buy),
    hold: recommendationCount(rec.hold),
    sell: recommendationCount(rec.sell),
    strongSell: recommendationCount(rec.strongSell),
  } : null;
}

export function recommendationTotal(data: AnalystResearchData | null): number | null {
  const rec = recommendationMix(data);
  if (!rec) return null;
  const values = [rec.strongBuy, rec.buy, rec.hold, rec.sell, rec.strongSell];
  return values.every((value): value is number => value != null)
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function formatRecommendationMix(data: AnalystResearchData | null): string {
  const rec = recommendationMix(data);
  if (!rec) return "-";
  const sells = rec.sell != null && rec.strongSell != null ? rec.sell + rec.strongSell : null;
  return `SB ${rec.strongBuy ?? "-"}  B ${rec.buy ?? "-"}  H ${rec.hold ?? "-"}  S ${sells ?? "-"}`;
}

export function formatRatingLabel(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? "-" : `${formatNumber(value, 1)}/10`;
}

export function analystTargetCurrency(data: AnalystResearchData | null): string | undefined {
  return data?.priceTarget?.currency?.trim() || data?.currency?.trim() || undefined;
}

export function formatAnalystPrice(value: number | undefined, currency: string | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (!currency?.trim()) return `${formatNumber(value)} (ccy?)`;
  const unit = resolveCurrencyUnit(currency);
  return formatCurrency(value / unit.divisor, unit.currency);
}

export function formatPriceTarget(value: number | undefined, currency: string | undefined): string {
  return formatAnalystPrice(value, currency)
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
  currency: string | undefined,
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
  if (row.currentPriceTarget == null || row.priorPriceTarget == null
    || !Number.isFinite(row.currentPriceTarget) || !Number.isFinite(row.priorPriceTarget)) return null;
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
  currency: string | undefined,
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

function footerSegmentWidth(segment: PaneFooterSegment): number {
  return segment.parts.reduce(
    (total, part, index) => total + displayWidth(part.text) + (index > 0 ? 1 : 0),
    0,
  );
}

/**
 * A status bar shrinks its segments into each other, which would leave a
 * reader with `rating 7.` and a label whose value never arrives. Keep whole
 * segments in falling order of worth instead, and drop the rest.
 */
function fitFooterSegments(segments: PaneFooterSegment[], availableWidth: number): PaneFooterSegment[] {
  const fitted: PaneFooterSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    const width = footerSegmentWidth(segment) + (fitted.length > 0 ? 1 : 0);
    if (used + width > availableWidth) break;
    fitted.push(segment);
    used += width;
  }
  return fitted;
}

/**
 * The consensus context a reader needs while reading the actions, kept in the
 * status bar: it belongs to the whole response rather than to any row, so it
 * would otherwise sit as a fixed block above the table it describes. Loading
 * and failure come first and keep their room; context fills what is left.
 */
export function buildAnalystFooterInfo(
  data: AnalystResearchData | null,
  { width, loading, error }: { width: number; loading: boolean; error: string | null },
): PaneFooterSegment[] {
  const lead = loadingErrorFooterInfo(loading, error);
  const leadWidth = lead.reduce((total, segment) => total + footerSegmentWidth(segment) + 1, 0);
  return [
    ...lead,
    ...fitFooterSegments(buildAnalystStatusSegments(data), Math.max(0, width - 2 - leadWidth)),
  ];
}

export function buildAnalystStatusSegments(data: AnalystResearchData | null): PaneFooterSegment[] {
  if (!data) return [];

  const target = data.priceTarget;
  const currency = analystTargetCurrency(data);
  const price = (value: number | undefined) => formatAnalystPrice(value, currency);
  const rec = latestRecommendation(data);
  const total = recommendationTotal(data);
  const segments: PaneFooterSegment[] = [];

  if (data.stale) segments.push({ id: "analyst-stale", parts: [{ text: "stale", tone: "warning" }] });

  if (target && [target.low, target.median, target.high].some((value) => value != null)) {
    segments.push({
      id: "analyst-target-range",
      parts: [
        { text: "low", tone: "label" }, { text: price(target.low) },
        { text: "med", tone: "label" }, { text: price(target.median) },
        { text: "high", tone: "label" }, { text: price(target.high) },
      ],
    });
  }

  if (data.recommendationRating != null) {
    segments.push({
      id: "analyst-rating",
      parts: [{ text: "rating", tone: "label" }, { text: formatRatingLabel(data.recommendationRating) }],
    });
  }

  // Only an older mix needs its period named; the current one is the default.
  const period = rec && rec.period && !isCurrentMonthPeriod(rec.period) ? compactPeriod(rec.period) : null;
  if (rec || total != null) {
    segments.push({
      id: "analyst-mix",
      parts: [
        ...(rec ? [{ text: formatRecommendationMix(data) }] : []),
        ...(total != null
          ? [{ text: `${total} analysts${period ? ` (${period})` : ""}`, tone: "muted" as const }]
          : period ? [{ text: period, tone: "muted" as const }] : []),
      ],
    });
  }

  // The upside is only as good as the price it was measured against.
  if (target?.current != null) {
    segments.push({
      id: "analyst-reference-price",
      parts: [{ text: "upside vs", tone: "label" }, { text: price(target.current) }],
    });
  }

  if (!data.stale && data.fetchedAt) {
    segments.push({
      id: "analyst-fetched",
      parts: [{ text: `fetched ${formatRelativeTime(data.fetchedAt)} ago`, tone: "muted" }],
    });
  }

  return segments;
}

export interface AnalystTargetHistoryPoint {
  /** Day a covered firm published, ISO `yyyy-mm-dd`. */
  date: string;
  average: number;
  firms: number;
}

const TARGET_HISTORY_WINDOW_DAYS = 365;
const TARGET_HISTORY_SPAN_DAYS = 730;
const TARGET_HISTORY_MIN_FIRMS = 3;
const DAY_MS = 86_400_000;

function ratingDayTimestamp(date: string | undefined): number | null {
  const parsed = Date.parse(`${date?.trim() ?? ""}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function publishedTarget(row: AnalystRatingRecord): number | null {
  const target = row.currentPriceTarget;
  return target != null && Number.isFinite(target) && target > 0 ? target : null;
}

/**
 * Rebuilds the target consensus out of the dated targets the ratings history
 * carries: on each day a firm publishes, the mean of every covered firm's most
 * recent target. Targets leave the window instead of anchoring the mean
 * forever, and the prior attached to a rating stays out because the source
 * never dates it. This is not the provider's own historical mean, which is
 * never served for a past day: firms absent from the ratings history cannot be
 * in it, so the last point and the reported average usually differ.
 *
 * Older days still build coverage, but only the recent span is returned: a
 * source that reaches back years on a handful of firms would otherwise spend
 * the whole chart on a decade nobody is reading it for.
 */
export function buildAnalystTargetHistory(
  ratings: readonly AnalystRatingRecord[],
  options: { windowDays?: number; spanDays?: number; minFirms?: number } = {},
): AnalystTargetHistoryPoint[] {
  const windowMs = Math.max(1, options.windowDays ?? TARGET_HISTORY_WINDOW_DAYS) * DAY_MS;
  const spanMs = Math.max(1, options.spanDays ?? TARGET_HISTORY_SPAN_DAYS) * DAY_MS;
  const minFirms = Math.max(1, options.minFirms ?? TARGET_HISTORY_MIN_FIRMS);

  // The source lists the newest action first, so a firm's first entry on a day
  // is the one that stands for that day.
  const published = new Map<string, { day: number; firm: string; target: number }>();
  for (const row of ratings) {
    const firm = row.firm?.trim().toLocaleLowerCase();
    const day = ratingDayTimestamp(row.date);
    const target = publishedTarget(row);
    if (!firm || day == null || target == null) continue;
    const key = `${day}:${firm}`;
    if (!published.has(key)) published.set(key, { day, firm, target });
  }

  const observations = [...published.values()].sort((left, right) => left.day - right.day);
  const firstShownDay = (observations.at(-1)?.day ?? 0) - spanMs;
  const latestByFirm = new Map<string, { day: number; target: number }>();
  const history: AnalystTargetHistoryPoint[] = [];

  observations.forEach((observation, index) => {
    latestByFirm.set(observation.firm, { day: observation.day, target: observation.target });
    // One point per day, after every firm that published that day is in.
    if (observations[index + 1]?.day === observation.day) return;

    for (const [firm, entry] of latestByFirm) {
      if (observation.day - entry.day > windowMs) latestByFirm.delete(firm);
    }
    if (latestByFirm.size < minFirms || observation.day < firstShownDay) return;

    const total = [...latestByFirm.values()].reduce((sum, entry) => sum + entry.target, 0);
    history.push({
      date: new Date(observation.day).toISOString().slice(0, 10),
      average: total / latestByFirm.size,
      firms: latestByFirm.size,
    });
  });

  return history;
}
