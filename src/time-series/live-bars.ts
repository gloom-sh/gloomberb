import type { PricePoint, Quote } from "../types/financials";
import type { HistorySession } from "../types/price-history";
import { hasLikelyQuoteUnitMismatch } from "../utils/currency-units";
import { pricePointIntegrity } from "../utils/price-history-integrity";
import {
  calendarBarStart,
  isCalendarResolution,
  liveQuoteObservation,
  MIN_LIVE_QUOTE_TAIL_GAP_MS,
  quoteBelongsToLatestBar,
} from "./chart-data";
import { CHART_RESOLUTION_STEP_MS, type ManualChartResolution } from "./resolution";

const DAY_MS = 24 * 60 * 60_000;
const EXTENDED_HOURS_STATES = new Set(["PRE", "PREPRE", "POST", "POSTPOST"]);
const PRE_MARKET_STATES = new Set(["PRE", "PREPRE"]);
/** Bars formed without any history refresh stay bounded on a chart left open for weeks. */
const MAX_FORMED_BARS = 2_000;

export interface LiveBarOptions {
  now: number;
  resolution: ManualChartResolution;
  exchange?: string;
  assetCategory?: string;
  /**
   * Start of the current uninterrupted live observation. A quiet stretch inside
   * it had no trades, so it is not a gap in the history.
   */
  liveSince?: number;
  /** The history's declared bar contract and acquisition time, when its source provides one. */
  session?: Pick<HistorySession, "timestampConvention" | "observedAt">;
}

interface FormedBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Cumulative session volume before the bar's first observation, when known. */
  volumeStart: number | null;
  /** Cumulative session volume when the next bar opened. */
  volumeEnd: number | null;
  point: PricePoint | null;
}

interface HistoryAnchor {
  /** Identity of the loaded version of the history's newest bar. */
  key: string;
  time: number;
  /** Live extremes and close observed while this bar is still forming. */
  high: number | null;
  low: number | null;
  close: number | null;
  /** Cumulative volume when this version of the bar was loaded. */
  volumeBase: number | null;
  /** Cumulative volume when the next bar opened. */
  volumeEnd: number | null;
  point: { source: PricePoint; version: number; value: PricePoint } | null;
}

function pointTime(point: Pick<PricePoint, "date">): number {
  const date = point.date as Date | string | number;
  return date instanceof Date ? date.getTime() : new Date(date).getTime();
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function anchorKey(point: PricePoint, time: number): string {
  return `${time}|${point.open}|${point.high}|${point.low}|${point.close}|${point.volume}`;
}

function foldIntoBar(bar: PricePoint, observation: PricePoint): PricePoint {
  const open = finite(bar.open) ? bar.open : bar.close;
  const extremes = pricePointIntegrity(observation) ? [] : [observation.high, observation.low];
  const prices = [bar.high, bar.low, open, bar.close, observation.close, ...extremes].filter(finite);
  const volume = finite(bar.volume) || finite(observation.volume)
    ? (finite(bar.volume) ? bar.volume : 0) + (finite(observation.volume) ? observation.volume : 0)
    : undefined;
  return {
    ...bar,
    open,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: observation.close,
    ...(volume === undefined ? {} : { volume }),
  };
}

/**
 * Some sources end an intraday history with the latest trade stamped at its
 * own time, or at the session close, instead of at a bar open. It belongs to
 * the bar containing it. Kept as a point of its own, it would move the grid
 * every later bar is placed on.
 */
export function foldFinalObservation(
  history: PricePoint[],
  stepMs: number,
  session?: Pick<HistorySession, "timestampConvention">,
): PricePoint[] {
  const last = history.at(-1);
  const previous = history.at(-2);
  if (!last || !previous || !finite(last.close) || !finite(previous.close) || pricePointIntegrity(previous)) return history;
  const previousTime = pointTime(previous);
  const gap = pointTime(last) - previousTime;
  if (!(gap > 0)) return history;
  const declared = session?.timestampConvention === "bar-open-with-final-observation";
  let barTime: number;
  if (gap % stepMs !== 0) {
    if (!declared) {
      // Without a declaration, only a point inside a bar that itself sits on
      // its predecessor's grid. A partial opening bar is not an observation.
      const before = history.at(-3);
      if (gap >= stepMs || !before || (previousTime - pointTime(before)) % stepMs !== 0) return history;
    }
    barTime = previousTime + Math.floor(gap / stepMs) * stepMs;
  } else if (declared) {
    // A declared observation on the grid is the closing print, which ends the previous bar.
    barTime = pointTime(last) - stepMs;
  } else {
    return history;
  }
  return barTime === previousTime
    ? [...history.slice(0, -2), foldIntoBar(previous, last)]
    : [...history.slice(0, -1), { ...last, date: new Date(barTime) }];
}

/**
 * Folds streamed quotes into the forming bar of one price history. Unlike a
 * single quote appended to the loaded bars, it remembers every observed price
 * of the forming bar (its high and low), opens a new bar at each boundary, and
 * derives bar volume from the change in the quote's cumulative session volume.
 * Loaded provider bars stay authoritative: once a refresh covers a formed bar,
 * the provider's version replaces it.
 */
export class LiveBarAccumulator {
  private anchor: HistoryAnchor | null = null;
  private bars: FormedBar[] = [];
  private lastQuote: Quote | undefined;
  private lastTime = Number.NEGATIVE_INFINITY;
  private lastPrice = Number.NaN;
  /** The last observation was a pre-market quote, whose count is still the previous session's. */
  private lastPreMarket = false;
  private cumulative: number | null = null;
  private version = 0;
  private gapPending = false;
  private folded: { source: PricePoint[]; key: string; value: PricePoint[] } | null = null;

  apply(history: PricePoint[], quote: Quote | null | undefined, options: LiveBarOptions): PricePoint[] {
    const bars = this.onGrid(history, options);
    const latest = bars.at(-1);
    if (!latest) return bars;
    const latestTime = pointTime(latest);
    if (!Number.isFinite(latestTime)) return bars;
    const exchange = options.exchange || quote?.listingExchangeName || quote?.exchangeName;
    this.syncAnchor(latest, latestTime, options, exchange);
    if (quote) this.observe(latest, quote, options, exchange);
    return this.project(bars, latest);
  }

  /** The history with any trailing observation folded into its bar, computed once per loaded history. */
  private onGrid(history: PricePoint[], options: LiveBarOptions): PricePoint[] {
    if (isCalendarResolution(options.resolution)) return history;
    const key = `${options.resolution}|${options.session?.timestampConvention ?? ""}`;
    if (this.folded?.source === history && this.folded.key === key) return this.folded.value;
    const value = foldFinalObservation(history, CHART_RESOLUTION_STEP_MS[options.resolution], options.session);
    this.folded = { source: history, key, value };
    return value;
  }

  /** True once after a quote could not extend the tail across missing history. */
  takeReconcileRequest(): boolean {
    const requested = this.gapPending;
    this.gapPending = false;
    return requested;
  }

  private inBar(time: number, barTime: number, options: LiveBarOptions, exchange?: string): boolean {
    const { resolution } = options;
    if (!isCalendarResolution(resolution)) return time >= barTime && time - barTime < CHART_RESOLUTION_STEP_MS[resolution];
    // A calendar bar labelled with its own zone's date at UTC midnight starts
    // after `now` while that zone is ahead of UTC: London FX opens its day at
    // 23:00 UTC in summer. A quote shortly before such a bar is its live price.
    if (time < barTime) return barTime > options.now && barTime - time < DAY_MS;
    return quoteBelongsToLatestBar(barTime, time, resolution, exchange);
  }

  private sameBar(barTime: number, anchorTime: number, resolution: ManualChartResolution, exchange?: string): boolean {
    if (isCalendarResolution(resolution)) {
      return calendarBarStart(barTime, resolution, exchange) === calendarBarStart(anchorTime, resolution, exchange);
    }
    return barTime >= anchorTime && barTime - anchorTime < CHART_RESOLUTION_STEP_MS[resolution];
  }

  private syncAnchor(latest: PricePoint, latestTime: number, options: LiveBarOptions, exchange?: string): void {
    const { resolution } = options;
    const key = anchorKey(latest, latestTime);
    if (this.anchor?.key === key) return;
    const previous = this.anchor?.time === latestTime ? this.anchor : null;
    const formed = this.bars.find((bar) => this.sameBar(bar.time, latestTime, resolution, exchange));
    const later = this.bars.filter((bar) => bar.time > latestTime && !this.sameBar(bar.time, latestTime, resolution, exchange));
    // A newest bar that is still forming keeps what was watched live; a
    // completed one is the provider's final version.
    const forming = later.length === 0;
    const carried = forming ? previous ?? formed : null;
    this.anchor = {
      key,
      time: latestTime,
      high: carried?.high ?? null,
      low: carried?.low ?? null,
      close: carried?.close ?? null,
      // The provider's volume counts trades until it was loaded; later trades
      // add to it. A count observed before the load is older than that bar.
      volumeBase: this.observedSince(options.session?.observedAt, this.lastTime) ? this.cumulative : null,
      volumeEnd: forming ? null : this.cumulative,
      point: null,
    };
    this.bars = later;
    this.version += 1;
  }

  private observedSince(observedAt: number | undefined, time: number): boolean {
    return observedAt === undefined || time >= observedAt;
  }

  private shiftVolumes(shift: number): void {
    const shifted = (value: number | null) => value === null ? null : value - shift;
    for (const bar of this.bars) {
      bar.volumeStart = shifted(bar.volumeStart);
      bar.volumeEnd = shifted(bar.volumeEnd);
    }
    const anchor = this.anchor!;
    anchor.volumeBase = shifted(anchor.volumeBase);
    anchor.volumeEnd = shifted(anchor.volumeEnd);
  }

  /** Stops the forming bar's volume from absorbing trades that do not belong to it. */
  private closeFormingVolume(previous: number | null): void {
    const forming = this.bars.at(-1);
    if (!forming) {
      this.anchor!.volumeEnd ??= previous ?? this.cumulative;
      return;
    }
    if (forming.volumeEnd !== null) return;
    forming.volumeEnd = previous ?? this.cumulative;
    forming.point = null;
  }

  private observe(latest: PricePoint, quote: Quote, options: LiveBarOptions, exchange?: string): void {
    if (quote === this.lastQuote) return;
    this.lastQuote = quote;
    const observation = liveQuoteObservation(quote, options.now, options.assetCategory);
    if (!observation) return;
    const { time, price } = observation;
    const volume = finite(quote.volume) && quote.volume >= 0 ? quote.volume : null;
    if (time < this.lastTime) return;
    if (time === this.lastTime && price === this.lastPrice && (volume === null || volume === this.cumulative)) return;

    const anchor = this.anchor!;
    const forming = this.bars.at(-1);
    const latestClose = forming?.close ?? anchor.close ?? latest.close;
    if (hasLikelyQuoteUnitMismatch(
      { currency: quote.currency, price: latestClose },
      { currency: quote.currency, price },
    )) return;

    const { resolution } = options;
    const calendar = isCalendarResolution(resolution);
    const preMarket = !!quote.marketState && PRE_MARKET_STATES.has(quote.marketState);
    const previousTime = this.lastTime;
    let previous = this.cumulative;
    if (volume !== null && previous !== null && volume < previous) {
      // A new session's count starts from zero and all of it belongs to the
      // calendar bar it falls in. Any other drop re-anchors the count lower;
      // volume already attributed to bars stays and only later trades are added.
      const restarted = calendar && ((this.lastPreMarket && !preMarket)
        || calendarBarStart(time, "1d", exchange, false) !== calendarBarStart(previousTime, "1d", exchange, false));
      const base = restarted ? 0 : volume;
      this.shiftVolumes(previous - base);
      previous = base;
    }
    if (volume !== null) {
      const observedAt = options.session?.observedAt;
      if (anchor.volumeBase === null && this.observedSince(observedAt, time)) {
        anchor.volumeBase = previous !== null && this.observedSince(observedAt, previousTime) ? previous : volume;
      }
      if (forming && forming.volumeEnd === null && volume !== this.cumulative) forming.point = null;
      this.cumulative = volume;
    }
    this.lastTime = time;
    this.lastPrice = price;
    this.lastPreMarket = preMarket;
    this.version += 1;

    // Loaded intraday bars cover the regular session. Extended-hours prints
    // would extend or form bars that no refresh can confirm.
    if (!calendar && quote.marketState && EXTENDED_HOURS_STATES.has(quote.marketState)) {
      this.closeFormingVolume(previous);
      return;
    }
    if (forming && this.inBar(time, forming.time, options, exchange)) {
      forming.high = Math.max(forming.high, price);
      forming.low = Math.min(forming.low, price);
      forming.close = price;
      forming.point = null;
      return;
    }
    if (!forming && this.inBar(time, anchor.time, options, exchange)) {
      anchor.high = Math.max(anchor.high ?? price, price);
      anchor.low = Math.min(anchor.low ?? price, price);
      anchor.close = price;
      return;
    }
    const latestBarTime = forming?.time ?? anchor.time;
    if (time < latestBarTime) return;

    let barTime = time;
    if (calendar) {
      if (anchor.time % DAY_MS === 0) {
        // Keep the history's date labels so a new session lines up with its neighbours.
        barTime = Date.parse(`${calendarBarStart(time, resolution, exchange, false)}T00:00:00Z`);
        if (!(barTime > latestBarTime)) return;
      }
    } else {
      const step = CHART_RESOLUTION_STEP_MS[resolution];
      const watched = options.liveSince !== undefined && latestBarTime + step >= options.liveSince;
      if (!watched && time - latestBarTime > Math.max(MIN_LIVE_QUOTE_TAIL_GAP_MS, 3 * step)) {
        // Bars in between are missing, not quiet. Ask for the recent history instead.
        this.closeFormingVolume(previous);
        this.gapPending = true;
        return;
      }
      barTime = latestBarTime + Math.floor((time - latestBarTime) / step) * step;
    }

    this.closeFormingVolume(previous);
    if (this.bars.length >= MAX_FORMED_BARS) this.bars.splice(0, this.bars.length - MAX_FORMED_BARS + 1);
    // A calendar bar's first quote reports its session's whole count so far,
    // unless it is a pre-market quote still carrying the previous session's.
    const sessionCount = calendar && previous === null && !preMarket;
    this.bars.push({
      time: barTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volumeStart: sessionCount ? 0 : previous ?? volume,
      volumeEnd: null,
      point: null,
    });
  }

  private anchorPoint(latest: PricePoint): PricePoint {
    const anchor = this.anchor!;
    if (anchor.point?.source === latest && anchor.point.version === this.version) return anchor.point.value;
    let value = latest;
    // A later quote cannot establish which reported OHLC field was wrong.
    if (!pricePointIntegrity(latest)) {
      let volume = latest.volume;
      const end = anchor.volumeEnd ?? this.cumulative;
      if (finite(volume) && end !== null && anchor.volumeBase !== null) {
        volume += Math.max(0, end - anchor.volumeBase);
      }
      if (anchor.close !== null) {
        const close = anchor.close;
        const open = finite(latest.open) ? latest.open : latest.close;
        const high = finite(latest.high) ? latest.high : Math.max(open, latest.close);
        const low = finite(latest.low) ? latest.low : Math.min(open, latest.close);
        value = {
          ...latest,
          open,
          high: Math.max(high, open, latest.close, anchor.high ?? close, close),
          low: Math.min(low, open, latest.close, anchor.low ?? close, close),
          close,
          ...(volume !== latest.volume ? { volume } : {}),
        };
      } else if (volume !== latest.volume) {
        value = { ...latest, volume };
      }
    }
    anchor.point = { source: latest, version: this.version, value };
    return value;
  }

  private barPoint(bar: FormedBar, volumeKnown: boolean): PricePoint {
    if (bar.point) return bar.point;
    const end = bar.volumeEnd ?? this.cumulative;
    const volume = volumeKnown && bar.volumeStart !== null && end !== null ? Math.max(0, end - bar.volumeStart) : 0;
    bar.point = {
      date: new Date(bar.time),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      ...(volume > 0 ? { volume } : {}),
    };
    return bar.point;
  }

  private project(history: PricePoint[], latest: PricePoint): PricePoint[] {
    const merged = this.anchorPoint(latest);
    if (merged === latest && this.bars.length === 0) return history;
    const projected = history.slice();
    projected[projected.length - 1] = merged;
    const volumeKnown = finite(latest.volume);
    for (const bar of this.bars) projected.push(this.barPoint(bar, volumeKnown));
    return projected;
  }
}
