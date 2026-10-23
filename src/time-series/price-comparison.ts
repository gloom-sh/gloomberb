import { scalarPointValue } from "./alignment";
import { getTimeSeriesField } from "./field-catalog";
import type { ChartSpec, ResolvedSeries, TimeSeriesPoint } from "./types";
import { chartBarSizeSource, type ManualChartResolution } from "./resolution";
import type { TimeRange } from "./range";
import { zonedDateTimeParts } from "../utils/zoned-date-time";
import { barLastSession } from "../market-data/market/bar-period";
import {
  barCloseDay, isIntradayDailyBar, isReturnPeriod, LATEST_INTRADAY_TEXT, periodBaseDay, periodBaseIndex, periodDayText,
} from "../market-data/market/period-return";

const PRICE_COMPARISON_BASIS = "Price returns in each listing's currency; cash distributions and FX conversion excluded.";

export interface PriceComparison {
  seriesIds: string[];
  /** Display envelope; each leg retains its exact source endpoints below. */
  start: number | null;
  end: number | null;
  notice: string;
  alignment?: "session-date" | "timestamp";
  sourceBounds?: Record<string, { start: number; end: number }>;
  /**
   * Each compared leg's base and end as the notice names them, `YYYY-MM-DD`:
   * the day its base close is from, the day of its newest observation, and
   * whether that observation is the session still trading.
   */
  legs?: Record<string, { baseDay: string; endDay: string; intraday: boolean }>;
  /** Legs left out of the comparison, by the symbol asked for, and why; the rest still compare. */
  dropped?: Array<{ seriesId: string; label: string; reason: string }>;
}

export interface PriceComparisonOptions {
  /**
   * The chart's untouched preset range; null for authored dates or a view
   * panned or zoomed off it. A preset's legs each run to their own newest
   * observation, so one that is behind does not cut the others short, and a
   * calendar range (1W to 5Y) is measured from the close on or before the
   * same date a range before (periodBaseDay), as RETURN is.
   */
  preset?: TimeRange | null;
  now?: number;
}

export function observationDate(time: number, series: Pick<ResolvedSeries, "timeBasis">): string {
  const date = new Date(time);
  // Date-only provider bars are represented as UTC midnight throughout the app.
  // Timestamped bars use the exchange's local calendar; crypto uses UTC.
  if (time % 86_400_000 === 0 || !series.timeBasis) return date.toISOString().slice(0, 10);
  const { year, month, day } = zonedDateTimeParts(time, series.timeBasis.timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Date-only research windows select local sessions; runtime timestamps remain exact. */
export function priceObservationWindowFilter(
  series: ResolvedSeries,
  bounds: { start: number | null; end: number | null },
  resolution: ManualChartResolution | "auto",
  dateWindow: ChartSpec["viewport"]["dateWindow"] | null,
): (time: number) => boolean {
  const calendarBars = resolution === "1d" || resolution === "1wk" || resolution === "1mo";
  const calendarWindow = calendarBars && dateWindow
    && /^\d{4}-\d{2}-\d{2}$/.test(dateWindow.start)
    && /^\d{4}-\d{2}-\d{2}$/.test(dateWindow.end) ? dateWindow : null;
  return (time) => {
    if (!Number.isFinite(time)) return false;
    const key = calendarWindow ? observationDate(time, series) : null;
    return key !== null
      ? key >= calendarWindow!.start && key <= calendarWindow!.end
      : (bounds.start === null || time >= bounds.start) && (bounds.end === null || time <= bounds.end);
  };
}

export function priceComparisonBoundsForSeries(series: ResolvedSeries, comparison: PriceComparison | null) {
  // A leg left out of the comparison shows nothing of it.
  if (comparison?.dropped?.some((entry) => entry.seriesId === series.id)) return { start: null, end: null };
  return comparison?.sourceBounds?.[series.id] ?? comparison;
}

function displayDate(time: number): string {
  const iso = new Date(time).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace("T", " ").replace(".000Z", " UTC");
}

/** "Mon 21 Sep close (EWJ Fri 18 Sep close)": the text most legs share, then the others by symbol. */
function legsText(entries: ReadonlyArray<{ label: string; text: string }>): string {
  const groups = new Map<string, string[]>();
  for (const { label, text } of entries) groups.set(text, [...groups.get(text) ?? [], label]);
  const [main, ...rest] = [...groups].sort((left, right) => right[1].length - left[1].length);
  if (!main) return "";
  return rest.length ? `${main[0]} (${rest.map(([text, labels]) => `${labels.join(", ")} ${text}`).join("; ")})` : main[0];
}

/** A leg's venue, whose sessions say whether its newest bar is still trading. */
function legVenue(series: ResolvedSeries | undefined): string | undefined {
  return series?.timeBasis?.exchange || series?.listing?.exchange || undefined;
}

/** Comparable normalized closing-price legs share observed endpoints. Other chart meanings are unchanged. */
export function priceComparisonSeriesIds(spec: ChartSpec): string[] | null {
  if (spec.viewport.maxPoints !== undefined) return null;
  const visible = spec.series.filter((entry) => entry.visible !== false);
  if (visible.length < 2 || !visible.every((entry) => {
    const field = entry.source.kind === "security" ? getTimeSeriesField(entry.source.fieldId)?.id : null;
    return (field === "market.close" || field === "market.ohlcv")
      && (entry.transform === "percent" || entry.transform === "index100")
      && entry.transform === visible[0]!.transform
      && entry.panelId === visible[0]!.panelId
      && entry.source.kind === "security" && visible[0]!.source.kind === "security"
      && (entry.source.period ?? "auto") === (visible[0]!.source.period ?? "auto");
  })) return null;
  return visible.map((entry) => entry.id);
}

interface ComparedLeg {
  id: string;
  label: string;
  entry: ResolvedSeries;
  /** Every priced observation by key, chronological: a period's base can be before the window. */
  keys: string[];
  points: Map<string, TimeSeriesPoint>;
  /** The keys inside the window. */
  window: string[];
}

/**
 * Where each compared leg starts and ends, and what the comparison says of it.
 *
 * Calendar bars compare by session date. An untouched preset range measures
 * each leg from its own close on or before the same date a range before the
 * newest observation of the chart (periodBaseDay), the convention RETURN
 * and every period return share, and runs each leg to its own newest
 * observation. Authored dates and a panned view start every leg at the first
 * date they share and end them at the last. A leg with no prices, or one,
 * is left out with its reason and the others still compare.
 */
export function resolvePriceComparison(
  spec: ChartSpec,
  series: readonly ResolvedSeries[],
  bounds: { start: number | null; end: number | null },
  resolution: ManualChartResolution | "auto" = spec.viewport.resolution === "auto" ? "auto" : chartBarSizeSource(spec.viewport.resolution),
  dateWindow: ChartSpec["viewport"]["dateWindow"] | null = spec.viewport.dateWindow,
  options: PriceComparisonOptions = {},
): PriceComparison | null {
  const seriesIds = priceComparisonSeriesIds(spec);
  if (!seriesIds) return null;
  const now = options.now ?? Date.now();
  const byId = new Map(series.map((entry) => [entry.id, entry]));
  const calendarBars = resolution === "1d" || resolution === "1wk" || resolution === "1mo";
  const order = (left: string, right: string) => calendarBars ? left.localeCompare(right) : Number(left) - Number(right);
  const symbolOf = (id: string) => {
    const source = spec.series.find((entry) => entry.id === id)?.source;
    return source?.kind === "security" ? source.instrument.symbol : id;
  };
  // A leg not loaded yet (a seed from cached history) has not failed: nothing compares until it is.
  const unavailable = `${PRICE_COMPARISON_BASIS} Comparison unavailable: need two shared dates and a nonzero baseline.`;
  if (seriesIds.some((id) => !byId.has(id))) return { seriesIds, start: null, end: null, notice: unavailable };
  const dropped: NonNullable<PriceComparison["dropped"]> = [];
  const reported = new Set<string>();
  const legs: ComparedLeg[] = [];
  for (const id of seriesIds) {
    const entry = byId.get(id)!;
    const inWindow = priceObservationWindowFilter(entry, bounds, resolution, dateWindow);
    const points = new Map<string, TimeSeriesPoint>();
    const window = new Set<string>();
    for (const point of entry.points) {
      const time = point.date.getTime();
      if (!Number.isFinite(time) || scalarPointValue(point) === null) continue;
      const key = calendarBars ? observationDate(time, entry) : String(time);
      points.set(key, point);
      if (inWindow(time)) window.add(key);
    }
    const leg = { id, label: symbolOf(id), entry, keys: [...points.keys()].sort(order), points, window: [...window].sort(order) };
    if (leg.window.length) legs.push(leg);
    else if (entry.warning?.trim()) {
      // A leg that failed to load: the chart's errors already say why.
      dropped.push({ seriesId: id, label: leg.label, reason: entry.warning.trim() });
      reported.add(id);
    } else dropped.push({ seriesId: id, label: leg.label, reason: "no prices in this range" });
  }
  const nonzero = (leg: ComparedLeg, key: string) => scalarPointValue(leg.points.get(key)!) !== 0;
  // A weekly or monthly bar's close is from the last session of its period, which the notice dates it by.
  const barPeriod = resolution === "1wk" ? "week" : resolution === "1mo" ? "month" : null;
  const venue = legVenue(byId.get(seriesIds[0]!));
  const sessionDay = (key: string) => (barPeriod ? barLastSession(key, barPeriod, venue, now) : null) ?? key;
  const dayOf = (leg: ComparedLeg, key: string) => calendarBars ? key : observationDate(Number(key), leg.entry);
  const preset = options.preset ?? null;
  const period = !dateWindow && isReturnPeriod(preset) ? preset : null;
  const ownEnds = preset !== null && !dateWindow;
  const shared = (keys: (leg: ComparedLeg) => readonly string[]) => {
    const sets = legs.map((leg) => new Set(keys(leg)));
    return legs.length ? keys(legs[0]!).filter((key) => sets.every((set) => set.has(key))) : [];
  };
  const sharedWindow = shared((leg) => leg.window);
  const sharedStart = sharedWindow.find((key) => legs.every((leg) => nonzero(leg, key)));
  // The period is measured back from the chart's newest observation, by its session day.
  const anchor = period && legs.length
    ? legs.map((leg) => calendarBars ? sessionDay(leg.window.at(-1)!) : dayOf(leg, leg.window.at(-1)!)).sort().at(-1)!
    : null;
  const baseDay = anchor && period ? periodBaseDay(anchor, period) : null;
  const closeDay = (leg: ComparedLeg, key: string) => calendarBars && resolution !== "1d" ? barCloseDay(key, resolution, legVenue(leg.entry)) : key;
  // Intraday bars share their times, so their base is the last bar the legs share on or before the base day.
  const sharedBase = baseDay && !calendarBars ? (() => {
    const keys = shared((leg) => leg.keys).filter((key) => legs.every((leg) => nonzero(leg, key)));
    const index = periodBaseIndex(keys.map((key) => dayOf(legs[0]!, key)), baseDay);
    return index < 0 ? undefined : keys[index];
  })() : undefined;
  const startOf = (leg: ComparedLeg): string | undefined => {
    if (!baseDay) return sharedStart;
    if (!calendarBars) return sharedBase ?? sharedStart;
    const index = periodBaseIndex(leg.keys.map((key) => closeDay(leg, key)), baseDay);
    const base = index < 0 ? undefined : leg.keys[index];
    // Without a close on or before the base day (a listing younger than the range), its first close in range.
    return base !== undefined && nonzero(leg, base) ? base : leg.window.find((key) => nonzero(leg, key));
  };
  const sharedEnd = sharedWindow.at(-1);
  // Legs that share their dates compare over two of them or not at all; a leg that runs on its own is left out alone.
  const sharedSpan = sharedStart !== undefined && sharedEnd !== undefined && order(sharedStart, sharedEnd) < 0;
  const compared = baseDay || ownEnds || sharedSpan ? legs.flatMap((leg) => {
    const start = startOf(leg);
    const end = ownEnds ? leg.window.at(-1) : sharedEnd;
    if (start !== undefined && end !== undefined && order(start, end) < 0) return [{ leg, start, end }];
    if (baseDay || sharedStart !== undefined) {
      dropped.push({ seriesId: leg.id, label: leg.label, reason: start === undefined ? "no nonzero price to measure from in this range" : "only one price in this range" });
    }
    return [];
  }) : [];
  // "Left out: VIX; EWJ (only one price in this range)."
  const droppedText = dropped.length
    ? ` Left out: ${dropped.map((entry) => reported.has(entry.seriesId) ? entry.label : `${entry.label} (${entry.reason})`).join("; ")}.`
    : "";
  if (!compared.length) return { seriesIds, start: null, end: null, notice: unavailable, ...(dropped.length ? { dropped } : {}) };
  const sourceBounds = Object.fromEntries(compared.map(({ leg, start, end }) => [leg.id, {
    start: leg.points.get(start)!.date.getTime(),
    end: leg.points.get(end)!.date.getTime(),
  }]));
  const currentYear = new Date(now).getUTCFullYear();
  const legDays = Object.fromEntries(compared.map(({ leg, start, end }) => {
    const endDay = calendarBars ? sessionDay(end) : dayOf(leg, end);
    // A daily bar of the session still trading, or a week or month running through it.
    return [leg.id, { baseDay: calendarBars ? sessionDay(start) : dayOf(leg, start), endDay,
      intraday: calendarBars && isIntradayDailyBar(endDay, legVenue(leg.entry), now) }];
  }));
  const span = calendarBars
    ? (() => {
      const from = legsText(compared.map(({ leg }) => ({ label: leg.label, text: `${periodDayText(legDays[leg.id]!.baseDay, currentYear)} close` })));
      const to = legsText(compared.map(({ leg }) => ({ label: leg.label, text: legDays[leg.id]!.intraday
        ? `${periodDayText(legDays[leg.id]!.endDay, currentYear)}, ${LATEST_INTRADAY_TEXT}`
        : `${periodDayText(legDays[leg.id]!.endDay, currentYear)} close` })));
      return `From ${from} to ${to}; market session times may differ.`;
    })()
    : baseDay && sharedBase !== undefined
      ? `From ${periodDayText(legDays[compared[0]!.leg.id]!.baseDay, currentYear)} close to ${displayDate(Math.max(...Object.values(sourceBounds).map((range) => range.end)))}.`
      : `Shared observations: ${displayDate(Math.min(...Object.values(sourceBounds).map((range) => range.start)))} to ${displayDate(Math.max(...Object.values(sourceBounds).map((range) => range.end)))}.`;
  return {
    seriesIds,
    start: Math.min(...Object.values(sourceBounds).map((range) => range.start)),
    end: Math.max(...Object.values(sourceBounds).map((range) => range.end)),
    alignment: calendarBars ? "session-date" : "timestamp",
    sourceBounds,
    legs: legDays,
    ...(dropped.length ? { dropped } : {}),
    notice: `${PRICE_COMPARISON_BASIS} ${span}${droppedText}`,
  };
}

/** Whether a comparison's newest point is the session still trading on any leg. */
export function priceComparisonEndsIntraday(comparison: PriceComparison | null | undefined): boolean {
  return Object.values(comparison?.legs ?? {}).some((leg) => leg.intraday);
}

/**
 * The bars a compared leg pans and zooms over: inside the view only its shared
 * dates, as the chart shows them, and every loaded bar past either edge of the
 * view. Clipping the whole buffer to the view left a pan or a zoom out nothing
 * to move into until the next fetch, and none at all toward newer bars.
 */
export function comparedBufferPoints(
  points: readonly TimeSeriesPoint[],
  shared: { start: number | null; end: number | null },
  view: { start: number | null; end: number | null },
): TimeSeriesPoint[] {
  const { start, end } = shared;
  if (start === null || end === null) return [];
  const before = view.start === null ? Number.NEGATIVE_INFINITY : Math.min(start, view.start);
  const after = view.end === null ? Number.POSITIVE_INFINITY : Math.max(end, view.end);
  return points.filter((point) => {
    const time = point.date.getTime();
    return time < before || time > after || (time >= start && time <= end);
  });
}

/** A compared leg's pan buffer around `view`; see comparedBufferPoints. */
export function bufferPriceComparison(
  series: ResolvedSeries,
  comparison: PriceComparison | null,
  view: { start: number | null; end: number | null },
): ResolvedSeries {
  if (!comparison?.seriesIds.includes(series.id)) return series;
  return {
    ...series,
    latestChangePercent: undefined,
    points: comparedBufferPoints(series.points, priceComparisonBoundsForSeries(series, comparison)!, view),
  };
}

/** Clip only compared legs; raw observations and study inputs stay available in the source cache. */
export function clipPriceComparison(series: ResolvedSeries, comparison: PriceComparison | null): ResolvedSeries {
  if (!comparison?.seriesIds.includes(series.id)) return series;
  const { start, end } = priceComparisonBoundsForSeries(series, comparison)!;
  return {
    ...series,
    // The legend must describe the compared endpoint, not a newer one-leg quote.
    latestChangePercent: undefined,
    points: start === null || end === null ? [] : series.points.filter((point) => (
      point.date.getTime() >= start && point.date.getTime() <= end
    )),
  };
}
