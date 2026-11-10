import type { AssetDataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { TimeRange } from "../../../time-series/range";
import type { ManualChartResolution } from "../../../time-series/resolution";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";
import { DAY_SO_FAR_TEXT } from "../../../time-series/session-bar";
import type { PricePoint } from "../../../types/financials";
import type { HeadlessPaneFreshness } from "../../../types/headless";

/** Risk views need daily closes even when a chart preset defaults to intraday or weekly bars. */
export const CORRELATION_HISTORY_RESOLUTION: ManualChartResolution = "1d";

export async function loadCorrelationHistory(
  provider: AssetDataProvider, symbol: string, exchange: string, range: TimeRange,
  context?: MarketDataRequestContext,
) {
  const points = provider.getPriceHistoryForResolution
    ? await provider.getPriceHistoryForResolution(symbol, exchange, range, CORRELATION_HISTORY_RESOLUTION, context)
    : await provider.getPriceHistory(symbol, exchange, range, context);
  return clipPriceHistoryToRange(points, range);
}

/**
 * What an analysis of daily closes says when its newest day is a bar the source
 * has not finished: a coin's UTC day or a future's session under way
 * (`partial`), or a future's last trade before its settlement (`unsettled`).
 * That day is no close, so the line calls the bars daily bars and says so, as
 * `history` does, instead of dating a close by it, and dates it by the newest
 * of `quotedAt` (its listings' quote times) on that day. Nothing when `day`
 * (the newest date the analysis uses) is a finished bar in every history.
 */
export function unfinishedBarFreshness(
  histories: ReadonlyArray<ReadonlyArray<Pick<PricePoint, "date" | "partial" | "unsettled">> | undefined>,
  day: string | null | undefined,
  quotedAt: ReadonlyArray<number | null | undefined> = [],
  now = Date.now(),
): Pick<HeadlessPaneFreshness, "basis" | "note" | "asOf"> | null {
  if (!day) return null;
  const bars = histories.flatMap((history) => history?.filter((point) => new Date(point.date).toISOString().slice(0, 10) === day) ?? []);
  const note = bars.some((bar) => bar.partial) ? `the newest bar is ${DAY_SO_FAR_TEXT}`
    : bars.some((bar) => bar.unsettled) ? "the newest bar is not yet settled" : null;
  if (!note) return null;
  // The bar is as of its last update, the newest quote of its day, as G dates one (not its midnight).
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const updates = quotedAt.filter((time): time is number => typeof time === "number" && Number.isFinite(time)
    && time >= dayStart && time <= now + QUOTE_CLOCK_SKEW_MS);
  return { basis: "daily bars", note, ...(updates.length ? { asOf: new Date(Math.max(...updates)).toISOString() } : {}) };
}

/** How far ahead of this clock a quote's time may read and still be taken as now. */
const QUOTE_CLOCK_SKEW_MS = 10 * 60_000;

/** Below this many shared daily returns a correlation says why it has so few. */
const CORRELATION_EXPLAINED_RETURNS = 20;

interface CorrelationSide {
  label: string;
  /** Daily closes the side has in the range, contradictory bars left out. */
  closes: number;
}

/**
 * Why a pair has fewer than CORRELATION_EXPLAINED_RETURNS shared daily
 * returns: the side with no daily bars in the range, or, when both have bars,
 * how many each has. Null when there are enough.
 */
export function thinCorrelationNote(left: CorrelationSide, right: CorrelationSide, returns: number, range: string): string | null {
  if (returns >= CORRELATION_EXPLAINED_RETURNS) return null;
  const empty = [...new Set([left, right].filter((side) => side.closes === 0).map((side) => side.label))];
  if (empty.length > 0) return `${empty.join(" and ")} ${empty.length === 1 ? "has" : "have"} no daily bars in the ${range} range`;
  const bars = (count: number) => `${count} daily ${count === 1 ? "bar" : "bars"}`;
  const sides = left.label === right.label ? `${left.label} has ${bars(left.closes)}`
    : `${left.label} has ${bars(left.closes)} and ${right.label} ${bars(right.closes)}`;
  return `${sides} in the ${range} range; ${returns === 0 ? "no" : returns} daily ${returns === 1 ? "return falls" : "returns fall"} between dates both have`;
}

/** "3046:HKEX: 8 of 245 bars have contradictory prices in the source data; left out, as history leaves them blank", or null. */
export function contradictoryBarsNote(label: string, left: number, total: number): string | null {
  if (left <= 0) return null;
  return `${label}: ${left} of ${total} ${left === 1 && total === 1 ? "bar" : "bars"} ${left === 1 ? "has" : "have"} contradictory prices in the source data; left out, as history leaves them blank`;
}

export const CORRELATION_RETURN_BASIS = "Local-price close-to-close returns between shared UTC dates; cash distributions and FX conversion are excluded, and exchange closing times may differ.";

export const GEO_CORRELATION_CHANGE_BASIS = "Map series (GEO:) use the change in daily value between the same shared UTC dates, because counts such as transits can be zero.";
