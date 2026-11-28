import { scalarPointValue } from "./alignment";
import { getTimeSeriesField } from "./field-catalog";
import type { ChartSpec, ResolvedSeries, TimeSeriesPoint } from "./types";
import type { SplitAction } from "../types/financials";
import { CHART_RESOLUTION_STEP_MS, chartBarSizeSource, getChartResolutionLabel, isIntradayResolution, type ManualChartResolution } from "./resolution";
import type { TimeRange } from "./range";
import { zonedDateTimeParts } from "../utils/zoned-date-time";
import { isCurrencyCode } from "../utils/currency-pair";
import { priceComparisonCloseTimes } from "./coin-session-close";
import { barLastSession } from "../market-data/market/bar-period";
import { priceBasisBreaks, priceBasisFactor } from "../market-data/market/split-price-basis";
import {
  barCloseDay, isIntradayDailyBar, isReturnPeriod, LATEST_INTRADAY_TEXT, periodBaseDay, periodBaseIndex, periodDayText,
} from "../market-data/market/period-return";

const PRICE_COMPARISON_BASIS = "Price returns in each listing's currency; cash distributions and FX conversion excluded.";
const TOTAL_COMPARISON_BASIS = "Total returns in each listing's currency; cash distributions reinvested at the ex-date close, FX conversion excluded.";

/** `MSFT and THYAO:BIST from TRY`: the legs converted into the chart's currency, by the currency each was in. */
function convertedText(legs: ReadonlyArray<{ label: string; entry: ResolvedSeries | undefined }>): string | null {
  const byCurrency = new Map<string, string[]>();
  for (const { label, entry } of legs) {
    if (entry?.convertedFrom) byCurrency.set(entry.convertedFrom, [...byCurrency.get(entry.convertedFrom) ?? [], label]);
  }
  if (!byCurrency.size) return null;
  return [...byCurrency].map(([currency, labels]) => `${listLabels(labels)} from ${currency}`).join(", ");
}

/**
 * What a comparison's returns are: price returns, or total returns when the
 * chart asked for them, naming any leg whose distributions could not be read
 * (it stays a price return, and the others do not wait for it). A chart in one
 * currency names the legs converted into it.
 */
function comparisonBasis(spec: ChartSpec, legs: ReadonlyArray<{ label: string; entry: ResolvedSeries | undefined }>): string {
  const target = spec.viewport.currency;
  const priceOnly = spec.viewport.totalReturn === true ? legs.filter(({ entry }) => entry?.returnBasis === "price").map(({ label }) => label) : [];
  const total = spec.viewport.totalReturn === true && !(priceOnly.length === legs.length && legs.length > 0);
  if (!target) {
    if (!total) return PRICE_COMPARISON_BASIS;
    return priceOnly.length ? `${TOTAL_COMPARISON_BASIS} Price return for ${priceOnly.join(", ")}: distribution history unavailable.` : TOTAL_COMPARISON_BASIS;
  }
  const converted = convertedText(legs);
  const basis = `${total ? "Total" : "Price"} returns in ${target}${converted ? `, ${converted} at each day's FX close` : ""}; ${
    total ? "cash distributions reinvested at the ex-date close." : "cash distributions excluded."}`;
  return total && priceOnly.length ? `${basis} Price return for ${priceOnly.join(", ")}: distribution history unavailable.` : basis;
}

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
   * panned or zoomed off it. A calendar range (1W to 5Y) is measured from
   * the close on or before the same date a range before the shared end
   * (periodBaseDay), as RETURN is.
   */
  preset?: TimeRange | null;
  now?: number;
  /** Coin legs whose daily closes were taken at the session venue's close (coinLegsAtSessionClose). */
  atSessionClose?: ReadonlySet<string>;
  /** Of those, the legs whose newest day ends at a session close that has passed: not a price still moving. */
  closedEnds?: ReadonlySet<string>;
}

export function observationDate(time: number, series: Pick<ResolvedSeries, "timeBasis">): string {
  const date = new Date(time);
  // Date-only provider bars are represented as UTC midnight throughout the app.
  // Timestamped bars use the exchange's local calendar; crypto uses UTC.
  if (time % 86_400_000 === 0 || !series.timeBasis) return date.toISOString().slice(0, 10);
  const { year, month, day } = zonedDateTimeParts(time, series.timeBasis.timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The day the weekly or monthly bar holding `date` is dated by: its week's
 * Monday or its month's 1st, as `history --from` keeps the week or month its
 * first date falls in. A daily bar is its own day.
 */
function windowBarStart(date: string, resolution: "1d" | "1wk" | "1mo"): string {
  if (resolution === "1mo") return `${date.slice(0, 7)}-01`;
  if (resolution === "1d") return date;
  const day = Date.parse(`${date}T00:00:00Z`);
  return new Date(day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Date-only research windows select local sessions; runtime timestamps remain
 * exact. Weekly and monthly bars keep the bar the window starts in: a window
 * from 2019-12-31 in monthly bars starts with December 2019's, whose close is
 * that day's, so a comparison is measured from it.
 */
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
  const start = calendarWindow ? windowBarStart(calendarWindow.start, resolution as "1d" | "1wk" | "1mo") : null;
  return (time) => {
    if (!Number.isFinite(time)) return false;
    const key = calendarWindow ? observationDate(time, series) : null;
    return key !== null
      ? key >= start! && key <= calendarWindow!.end
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

/**
 * The currency each compared leg's return is in, by series id, where the
 * chart would not say it otherwise: every leg's own currency when
 * they are in more than one (GUBRF.IS in TRY beside NTR in USD), or the
 * chart's `viewport.currency` for every leg it converts. Empty for legs all in
 * one currency, the chart's own, or a currency their unit does not name.
 */
export function comparisonLegCurrencies(
  series: readonly Pick<ResolvedSeries, "id" | "unit" | "rawUnit" | "convertedFrom">[],
  seriesIds: readonly string[] | null | undefined,
  target?: string,
): Map<string, string> {
  const compared = new Set(seriesIds ?? []);
  const legs = series.flatMap((entry) => {
    // The currency the price unit leads with: `TRY`, `TRY/share`, `USD / gallon`.
    const unit = /^([A-Za-z]{3})(?![A-Za-z])/.exec((entry.rawUnit ?? entry.unit).trim())?.[1]?.toUpperCase();
    return compared.has(entry.id) && unit && isCurrencyCode(unit) ? [{ id: entry.id, currency: unit, converted: !!entry.convertedFrom }] : [];
  });
  if (target ? !legs.some((leg) => leg.converted) : new Set(legs.map((leg) => leg.currency)).size < 2) return new Map();
  return new Map(legs.map((leg) => [leg.id, leg.currency] as const));
}

/**
 * What a total-return chart's price levels are when it is not a comparison (the
 * raw price axis): prices with cash distributions reinvested, not what the
 * listing quotes. A chart in one currency names the legs converted into it.
 * Null for a price chart in each listing's currency, and when no leg is a
 * total return or was converted.
 */
export function priceLevelsNotice(spec: ChartSpec, series: readonly ResolvedSeries[]): string | null {
  const target = spec.viewport.currency;
  const converted = target ? convertedText(series.map((entry) => ({ label: entry.label.replace(/ (?:Close|Price|Open|High|Low|Total return)$/, ""), entry }))) : null;
  const conversion = converted ? `${converted} at each day's FX close` : null;
  const legs = spec.viewport.totalReturn === true ? series.filter((entry) => entry.returnBasis !== undefined) : [];
  if (!legs.some((entry) => entry.returnBasis === "total")) return conversion ? `Prices in ${target}: ${conversion}.` : null;
  const priceOnly = legs.filter((entry) => entry.returnBasis === "price").map((entry) => entry.label);
  return `Total return levels in ${target ?? "each listing's currency"}: prices include cash distributions reinvested at the ex-date close, so they are not quoted prices; ${
    conversion ?? (target ? "none needed converting" : "FX conversion excluded")}.${
    priceOnly.length ? ` Price only for ${priceOnly.join(", ")}: distribution history unavailable.` : ""}`;
}

/** `10-for-1` or `1-for-20 reverse`: a split by whole share counts, as its source states it; null for anything else (a spinoff's price adjustment). */
function splitTerms(split: SplitAction): string | null {
  const { fromFactor: from, toFactor: to } = split;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from! <= 0 || to! <= 0 || from === to) return null;
  return `${to}-for-${from}${to! < from! ? " reverse" : ""}`;
}

/**
 * Describe recorded splits separately from breaks in the served bars. A split record alone cannot tell
 * which bars are on which basis. Withhold returns only for the legs whose windows cross a break.
 * Null split history is unavailable or not yet read, not a successful empty result.
 */
export function comparisonSplitAssessment(
  comparison: Pick<PriceComparison, "legs" | "sourceBounds">,
  legs: ReadonlyArray<{ id: string; label: string; splits: readonly SplitAction[] | null; series?: ResolvedSeries }>,
  now = Date.now(),
): { notice: string | null; dropped: NonNullable<PriceComparison["dropped"]> } {
  const currentYear = new Date(now).getUTCFullYear();
  const named: string[] = [];
  const dropped: NonNullable<PriceComparison["dropped"]> = [];
  for (const { id, label, splits, series } of legs) {
    const window = comparison.legs?.[id];
    if (!window) continue;
    const recordedSplits = splits ?? [];
    const inside = recordedSplits
      .filter((split) => /^\d{4}-\d{2}-\d{2}/.test(split.date) && split.date.slice(0, 10) > window.baseDay && split.date.slice(0, 10) <= window.endDay)
      .sort((left, right) => left.date.localeCompare(right.date))
      .flatMap((split) => {
        const terms = splitTerms(split);
        return terms ? [`${terms} on ${periodDayText(split.date, currentYear)}`] : [];
      });
    if (inside.length) named.push(`${label} ${listLabels(inside)}`);
    const bounds = comparison.sourceBounds?.[id];
    if (!series || !bounds) continue;
    const bars = series.points.flatMap((point) => {
      const time = point.date.getTime();
      return time >= bounds.start && time <= bounds.end ? [{ date: observationDate(time, series),
        close: point.close ?? point.value, high: point.high, low: point.low }] : [];
    });
    const breaks = priceBasisBreaks(bars, recordedSplits, { interval: series.historyResolution, venue: legVenue(series),
      includeUnrecorded: true, includeUnrecordedRange: splits === null });
    if (breaks.length) {
      const period = series.historyResolution === "1mo" ? "monthly" : series.historyResolution === "1wk" ? "weekly" : null;
      const descriptions = breaks.map(({ day, ratio, kind, split }) => {
        const move = kind === "close" ? `close ${ratio < 1 ? "falls" : "rises"}` : "high/low range is";
        const evidence = split ? `near the ${periodDayText(split.date.slice(0, 10), currentYear)} split`
          : splits === null ? "with split history unavailable" : "with no split recorded nearby";
        return `${move} ${priceBasisFactor(ratio)}× ${period ? `in the ${period} bar dated` : "on"} ${periodDayText(day, currentYear)} ${evidence}`;
      });
      dropped.push({ seriesId: id, label, reason: `${descriptions.join("; ")}. A consistent price basis cannot be verified` });
    }
  }
  const splitsLine = named.length ? `Splits in range: ${named.join("; ")}` : null;
  const notice = dropped.length ? [splitsLine && `${splitsLine}.`, ...dropped.map(({ label, reason }) => `${label}: ${reason}; returns withheld.`)]
    .filter(Boolean).join(" ") : splitsLine && `${splitsLine}; returns are split-adjusted.`;
  return { notice, dropped };
}

/**
 * The bar size intraday legs are matched in: the chart's, or when it has none
 * the coarsest the legs were served in. Null when neither is intraday.
 */
function intradayBucketMs(resolution: ManualChartResolution | "auto", series: ReadonlyArray<ResolvedSeries | undefined>): number | null {
  const sizes = [resolution, ...series.map((entry) => entry?.historyResolution)]
    .filter((size): size is ManualChartResolution => !!size && size !== "auto" && size in CHART_RESOLUTION_STEP_MS && isIntradayResolution(size as ManualChartResolution));
  if (resolution !== "auto" && sizes[0] === resolution) return CHART_RESOLUTION_STEP_MS[resolution];
  return sizes.length ? Math.max(...sizes.map((size) => CHART_RESOLUTION_STEP_MS[size])) : null;
}

/** `1H` for an hour's bucket, as the chart names its bar size. */
function barLabel(bucketMs: number): string {
  const size = (Object.keys(CHART_RESOLUTION_STEP_MS) as ManualChartResolution[]).find((key) => CHART_RESOLUTION_STEP_MS[key] === bucketMs);
  return size ? getChartResolutionLabel(size) : `${Math.round(bucketMs / 60_000)}m`;
}

/** `IBIT and BTC-USD`, `A, B and C`. */
function listLabels(labels: readonly string[]): string {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
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
 * last shared observation (periodBaseDay), the convention RETURN and every
 * period return share. Authored dates and a panned view use a shared base.
 * A daily bar that is still forming is comparable only if it is forming on
 * every leg. A leg without a usable span is left out with its reason.
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
  const basisLegs = seriesIds.map((id) => ({ label: symbolOf(id), entry: byId.get(id) }));
  const basis = [comparisonBasis(spec, basisLegs), ...basisLegs.flatMap(({ label, entry }) =>
    entry?.returnRollNote ? [`${label}: ${entry.returnRollNote}.`] : [])].join(" ");
  const unavailable = `${basis} Comparison unavailable: need two shared dates and a nonzero baseline.`;
  if (seriesIds.some((id) => !byId.has(id))) return { seriesIds, start: null, end: null, notice: unavailable };
  const dropped: NonNullable<PriceComparison["dropped"]> = [];
  const reported = new Set<string>();
  const legs: ComparedLeg[] = [];
  // Intraday bars compare by the bar of the chart's size they open in: a fund's 13:30 bar and a coin's 13:00 bar are
  // one hourly bar, so the fund's last bar of the day (19:30, closing at 20:00) meets the coin's bar closing then.
  const bucketMs = calendarBars ? null : intradayBucketMs(resolution, seriesIds.map((id) => byId.get(id)!));
  for (const id of seriesIds) {
    const entry = byId.get(id)!;
    const inWindow = priceObservationWindowFilter(entry, bounds, resolution, dateWindow);
    const points = new Map<string, TimeSeriesPoint>();
    const window = new Set<string>();
    for (const point of entry.points) {
      const time = point.date.getTime();
      if (!Number.isFinite(time) || scalarPointValue(point) === null) continue;
      const key = calendarBars ? observationDate(time, entry) : String(bucketMs ? Math.floor(time / bucketMs) * bucketMs : time);
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
  const period = dateWindow?.returnPeriod ?? (!dateWindow && isReturnPeriod(preset) ? preset : null);
  const shared = (keys: (leg: ComparedLeg) => readonly string[]) => {
    const sets = legs.map((leg) => new Set(keys(leg)));
    return legs.length ? keys(legs[0]!).filter((key) => sets.every((set) => set.has(key))) : [];
  };
  const sharedWindow = shared((leg) => leg.window);
  const isForming = (leg: ComparedLeg, key: string): boolean => calendarBars && !options.closedEnds?.has(leg.id)
    && (leg.points.get(key)?.partial === true || isIntradayDailyBar(sessionDay(key), legVenue(leg.entry), now));
  const sharedEnd = resolution === "1d"
    ? sharedWindow.findLast((key) => legs.every((leg) => isForming(leg, key) === isForming(legs[0]!, key)))
    : sharedWindow.at(-1);
  // Authored dates (`--from 2026-10-19`) measure from the close before the first date, as RETURN does: the last
  // date the legs share before it. Weekly and monthly bars keep the bar the window starts in.
  const authoredFrom = !preset && !period && dateWindow && /^\d{4}-\d{2}-\d{2}$/.test(dateWindow.start) && (resolution === "1d" || !calendarBars)
    ? dateWindow.start : null;
  const firstInWindow = authoredFrom ? legs.map((leg) => leg.window[0]!).sort(order)[0] : undefined;
  const authoredBase = authoredFrom && firstInWindow !== undefined
    ? shared((leg) => leg.keys).filter((key) => (calendarBars ? key < authoredFrom : order(key, firstInWindow) < 0)
      && legs.every((leg) => nonzero(leg, key))).at(-1)
    : undefined;
  const sharedStart = authoredBase ?? sharedWindow.find((key) => legs.every((leg) => nonzero(leg, key)));
  const anchor = dateWindow?.returnPeriod ? dateWindow.end
    : period && sharedEnd !== undefined ? (calendarBars ? sessionDay(sharedEnd) : dayOf(legs[0]!, sharedEnd)) : null;
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
  const compared = sharedEnd === undefined ? [] : legs.flatMap((leg) => {
    const start = startOf(leg);
    if (start !== undefined && order(start, sharedEnd) < 0) return [{ leg, start, end: sharedEnd }];
    if (baseDay || sharedStart !== undefined) {
      dropped.push({ seriesId: leg.id, label: leg.label, reason: start === undefined ? "no nonzero price to measure from in this range" : "only one price in this range" });
    }
    return [];
  });
  // "Left out: VIX; EWJ (only one price in this range)."
  const droppedText = dropped.length
    ? ` Left out: ${dropped.map((entry) => reported.has(entry.seriesId) ? entry.label : `${entry.label} (${entry.reason})`).join("; ")}.`
    : "";
  if (!compared.length) {
    // Intraday legs that never trade in the same bar: said, with the bar size that compares them.
    const apart = !calendarBars && legs.length >= 2 && sharedWindow.length === 0 && legs.every((leg) => leg.window.length >= 2);
    const notice = apart
      ? `${basis} Comparison unavailable: ${listLabels(legs.map((leg) => leg.label))} share no ${bucketMs ? `${barLabel(bucketMs)} ` : ""}bar times in this range; daily bars (1D) compare them.`
      : unavailable;
    return { seriesIds, start: null, end: null, notice, ...(dropped.length ? { dropped } : {}) };
  }
  const sourceBounds = Object.fromEntries(compared.map(({ leg, start, end }) => [leg.id, {
    start: leg.points.get(start)!.date.getTime(),
    end: leg.points.get(end)!.date.getTime(),
  }]));
  const currentYear = new Date(now).getUTCFullYear();
  const legDays = Object.fromEntries(compared.map(({ leg, start, end }) => {
    const endDay = calendarBars ? sessionDay(end) : dayOf(leg, end);
    return [leg.id, { baseDay: calendarBars ? sessionDay(start) : dayOf(leg, start), endDay,
      intraday: isForming(leg, end) }];
  }));
  const span = calendarBars
    ? (() => {
      const from = legsText(compared.map(({ leg }) => ({ label: leg.label, text: `${periodDayText(legDays[leg.id]!.baseDay, currentYear)} close` })));
      const to = legsText(compared.map(({ leg }) => ({ label: leg.label, text: legDays[leg.id]!.intraday
        ? `${periodDayText(legDays[leg.id]!.endDay, currentYear)}, ${LATEST_INTRADAY_TEXT}`
        : `${periodDayText(legDays[leg.id]!.endDay, currentYear)} close` })));
      // A coin beside a listing that closes each day says when it is measured: at that close, or at 00:00 UTC.
      const timing = priceComparisonCloseTimes({ legs: legDays }, compared.map(({ leg }) => leg.entry),
        new Map(compared.map(({ leg }) => [leg.id, leg.label])), options.atSessionClose);
      return `From ${from} to ${to}; ${timing ?? "market session times may differ"}.`;
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
    notice: `${basis} ${span}${droppedText}`,
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
  if (comparison.dropped?.some((entry) => entry.seriesId === series.id)) return { ...series, points: [] };
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
