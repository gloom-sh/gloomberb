import { isRegularSessionTime } from "../../../market-data/market/freshness";
import { isIntradayResolution } from "../../../time-series/resolution";
import type { ResolvedSeries } from "../../../time-series/types";
import { fillRect, parseHex } from "../native/raster/primitives";
import { clamp } from "../../../utils/math";
import type { CompositeExtendedHoursSpan } from "./types";

const DAY_MS = 86_400_000;
const SHADE_OPACITY = 0.08;
/** Scenes rebuild on every pan and tick; a bar's session never changes. */
const sessionCache = new Map<string, boolean | null>();

function isRegular(exchange: string, time: number): boolean | null {
  const key = `${exchange}:${time}`;
  let regular = sessionCache.get(key);
  if (regular === undefined) {
    if (sessionCache.size >= 50_000) sessionCache.clear();
    regular = isRegularSessionTime(exchange, time);
    sessionCache.set(key, regular);
  }
  return regular;
}

/** Whether a series holds intraday bars, by its cadence or its acquired resolution. */
export function isIntradaySeries(series: ResolvedSeries): boolean {
  const cadence = series.timeBasis?.cadenceMs;
  if (cadence !== undefined) return cadence < DAY_MS;
  return !!series.historyResolution && isIntradayResolution(series.historyResolution);
}

/**
 * The plot spans, as x ratios, of intraday bars outside the regular session
 * of the market the chart is laid out on: pre-market and after-hours. Each
 * span reaches halfway to the bars beside it. None on daily bars or for a
 * venue without known hours.
 */
export function extendedHoursSpans(
  anchor: ResolvedSeries | undefined,
  dates: readonly Date[],
  ratios: readonly number[],
): CompositeExtendedHoursSpan[] {
  const exchange = anchor?.timeBasis?.exchange;
  if (!anchor || !exchange || !isIntradaySeries(anchor) || dates.length === 0) return [];
  const edge = (index: number, side: -1 | 1) => {
    const ratio = ratios[index]!;
    // At either end of the plot, mirror the gap to the bar on the other side.
    const gap = Math.abs((ratios[index - side] ?? ratio) - ratio);
    return clamp((ratio + (ratios[index + side] ?? ratio + side * gap)) / 2, 0, 1);
  };
  const spans: CompositeExtendedHoursSpan[] = [];
  let first: number | null = null;
  dates.forEach((date, index) => {
    const outside = isRegular(exchange, date.getTime()) === false;
    if (outside && first === null) first = index;
    const closesRun = first !== null && (!outside || index === dates.length - 1);
    if (!closesRun) return;
    const last = outside ? index : index - 1;
    spans.push({ start: edge(first!, -1), end: edge(last, 1), startsAfterBar: first! > 0, endsBeforeBar: last < dates.length - 1 });
    first = null;
  });
  return spans;
}

/** Tints extended-hours spans under everything else on the panel raster. */
export function paintExtendedHours(
  data: Uint8Array,
  width: number,
  height: number,
  spans: readonly CompositeExtendedHoursSpan[],
  color: string,
): void {
  const tint = parseHex(color);
  const maxX = Math.max(width - 1, 0);
  for (const span of spans) {
    fillRect(data, width, height, Math.round(span.start * maxX), 0, Math.round(span.end * maxX) - 1, height - 1, tint, SHADE_OPACITY);
  }
}

/**
 * The text plot cannot tint a background, so it marks where the regular
 * session meets extended hours with a dotted rule in blank cells.
 */
export function writeSessionBreaksText(
  rows: string[][],
  width: number,
  spans: readonly CompositeExtendedHoursSpan[],
): void {
  for (const span of spans) {
    // Only where extended hours meet a regular bar: the first or last bar
    // loaded, or the plot's own edge, is not a session break.
    const breaks = [...(span.startsAfterBar ? [span.start] : []), ...(span.endsBeforeBar ? [span.end] : [])];
    for (const ratio of breaks) {
      if (ratio <= 0 || ratio >= 1) continue;
      const x = clamp(Math.round(ratio * Math.max(width - 1, 0)), 0, Math.max(width - 1, 0));
      for (const row of rows) {
        if (row[x] === " " || row[x] === "·") row[x] = "┊";
      }
    }
  }
}
