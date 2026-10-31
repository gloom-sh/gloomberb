import { INDEX_POINTS_EXPORT_UNIT, INDEX_POINTS_LABEL, isIndexLevel } from "../market-data/market/index-level";
import type { PricePoint } from "../types/financials";
import { formatPriceObservation, marketPriceFractionDigitCeiling, resolveAssetDisplayKind } from "../market-data/market/format";
import { TIME_RANGES, type TimeRange } from "../time-series/range";
import { subtractTimeRange } from "../time-series/date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  isIntradayResolution,
  RANGE_HISTORY_RESOLUTION,
  type ManualChartResolution,
} from "../time-series/resolution";
import { classifyInstrumentType } from "../tickers/instrument-kind";
import { isRoundTheClockCoin } from "../utils/crypto-pair";
import { currencyPairCode } from "../utils/currency-pair";
import { currencyUnitLabel, resolveCurrencyUnit } from "../utils/currency-units";
import { getPricePointTimestamp } from "../utils/price-history";
import {
  isWickFlag, latestTradeIndex, missingVolumeNotice, pricePointIntegrityFlags, pricePointValues, pricePointWickFlags,
} from "../utils/price-history-integrity";
import { formatUtcTime } from "../utils/utc-time";
import { maxDrawdown, type MaxDrawdown } from "../utils/max-drawdown";
import { historyCoverageNotice } from "../sources/history-coverage";
import { barLastSession, barPeriodToDate, type BarPeriodToDate } from "../market-data/market/bar-period";
import { barSizeFromGap, medianBarGap } from "../time-series/bar-spacing";
import { isRegularSessionTime, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { zonedDateKey } from "../utils/zoned-date-time";

const PRICE_KEYS = ["open", "high", "low", "close"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Daily bars are a day apart even when stamped at the session open. */
const INTRADAY_MAX_GAP_MS = 20 * 60 * 60 * 1000;
const INTRADAY_RESOLUTIONS = ["1m", "5m", "15m", "30m", "45m", "1h"] as const;
/** A first bar later than this after the range's start is a late start, not a weekend or holiday. */
const LATE_START_MIN_MS = 10 * DAY_MS;
const LATE_START_MIN_BARS = 3;
/** A close more than this many times the close before it, or less than its hundredth, follows a jump. */
const BREAK_JUMP_RATIO = 100;
/** Flag codes for a break before a bar, whose prices stay as served; every other code blanks them. */
const BREAK_FLAGS: ReadonlySet<string> = new Set(["gap", "jump"]);
const FIRST_MONDAY_MS = Date.UTC(1970, 0, 5);

export const BAR_INTERVAL_LABELS: Record<ManualChartResolution, string> = {
  "1m": "1-minute",
  "5m": "5-minute",
  "15m": "15-minute",
  "30m": "30-minute",
  "45m": "45-minute",
  "1h": "hourly",
  "1d": "daily",
  "1wk": "weekly",
  "1mo": "monthly",
};

export interface HistoryRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** Currency code of the prices; null for index points or when no source says. */
  currency: string | null;
  /** What one price is, as `historyUnit` names it: `USD`, `index points`, `ZAR per USD`; null when no source says. */
  unit: string | null;
  /** Bar size, in the codes of `resolution`: 5m, 1h, 1d, 1wk, 1mo. */
  interval: ManualChartResolution | null;
  /**
   * Each way the bar's prices contradict each other, such as `high<open`, and
   * `gap` or `jump` for a break in the series just before it; null when none.
   */
  flag: string | null;
  /** The bar's period had not ended when it was served: the close is the latest price. */
  partial?: true;
  /** The bar's prices were rebuilt from hourly bars where the source left the day empty. */
  filled?: true;
  /** A future's session has closed but its settlement is not confirmed yet: the close is the last trade. */
  unsettled?: true;
  /** What the volume counts, when the history says: a coin's is traded value in its quote currency (`USD`). */
  volumeUnit?: string;
  /** Why a coin's bar has no volume: `day in progress`, `rebuilt from hourly bars`, `latest trade` (not a bar), `not reported`. */
  volumeNote?: string;
  /** A bar without the market's volume: the trades of one venue alone (`volumeVenue`), never its volume. */
  venueVolume?: number;
  volumeVenue?: string;
  /**
   * What the bar's volume counts, where the source says: `aggregate` across venues on a coin's daily bar,
   * `3 spot venues` on its intraday bar, whose volume is summed over those venues.
   */
  volumeBasis?: string;
  /** A continuous future's bar (NG=F): the contract it closes on (NGZ26), where the source says. */
  contract?: string;
  /** The first bar on a contract after another's: the series rolled into `contract` at this bar. */
  roll?: true;
  /** The bar traded far below the bars around it (THIN_VOLUME_SHARE of their median): a price on few trades. */
  thin?: true;
}

/** A coin's volume: traded value in its quote currency, per UTC day on daily bars. */
export interface HistoryVolume {
  unit: string;
}

function decimalPlaces(value: number): number {
  const [mantissa = "", exponent = "0"] = Math.abs(value).toString().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}

/**
 * Providers serve prices as float32: The feed sends the exact float
 * (340.33 arrives as 340.3299865722656) and the cloud a float already rounded
 * to a few decimals (254.42999). Return the shortest decimal that is the same
 * float32. Values with fewer than five decimals are left alone, and a precise
 * double only moves within float32 precision (about seven significant digits).
 */
export function cleanFloat32Price(value: number): number {
  if (!Number.isFinite(value) || value === 0 || decimalPlaces(value) < 5) return value;
  const target = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) !== target) continue;
    return candidate.toString().length < value.toString().length ? candidate : value;
  }
  return value;
}

/**
 * The finest step a venue that quotes in a sub-unit prices in, in decimals of
 * that unit: a ten-thousandth of a penny, the smallest tick London's tick
 * tables use (for its lowest-priced shares).
 */
const SUB_UNIT_TICK_DECIMALS = 4;
/** The decimals of that sub-unit a table of bars shows: a tenth of a penny, 638.5p as 6.385. */
const SUB_UNIT_SHOWN_DECIMALS = 1;

/**
 * A bar's price as the decimal it is (`cleanFloat32Price`). A price served in
 * a sub-unit and divided into its currency (`divisor` 100: a London line's
 * pence, as pounds) carries the float32 noise of the pence it was quoted in
 * (623.59998p is 6.2359998), so it is cleaned in pence, kept to the venue's
 * finest tick there, then divided: 6.236.
 */
export function cleanBarPrice(value: number, divisor = 1): number {
  if (!(divisor > 1) || !Number.isFinite(divisor) || !Number.isFinite(value) || value === 0) return cleanFloat32Price(value);
  const subUnit = cleanFloat32Price(value * divisor);
  const places = Math.min(SUB_UNIT_TICK_DECIMALS, decimalPlaces(subUnit));
  const unitPlaces = Math.round(Math.log10(divisor));
  return Number((Number(subUnit.toFixed(places)) / divisor).toFixed(places + unitPlaces));
}

/**
 * How many of the unit a quote's prices were served in make one of the
 * currency it shows them in: 100 for a London line priced in pence and shown
 * in pounds, 1 for any other. A quote in a sub-unit itself (`GBp`) shows the
 * prices as served: they are cleaned as they are.
 */
export function quotedPriceDivisor(quote: { currency?: string; providerPriceDivisor?: number } | null | undefined): number {
  const divisor = quote?.providerPriceDivisor;
  if (resolveCurrencyUnit(quote?.currency).divisor > 1) return 1;
  return divisor != null && Number.isFinite(divisor) && divisor > 1 ? divisor : 1;
}

function isUtcMidnight(time: number): boolean {
  return new Date(time).toISOString().endsWith("T00:00:00.000Z");
}

/** Without a declared cadence, bar spacing decides: daily bars may be stamped at the session open. */
function looksIntraday(times: readonly number[]): boolean {
  const finite = times.filter(Number.isFinite);
  if (finite.length < 2) return finite.some((time) => !isUtcMidnight(time));
  const gap = medianBarGap(finite);
  return gap != null && gap < INTRADAY_MAX_GAP_MS;
}

/** The bar size served: as the source declared it, otherwise read from the typical spacing of the bars. */
function historyInterval(times: readonly number[], resolution: ManualChartResolution | null): ManualChartResolution | null {
  if (resolution) return resolution;
  const gap = medianBarGap(times);
  if (gap == null) return null;
  if (gap < INTRADAY_MAX_GAP_MS) {
    return INTRADAY_RESOLUTIONS.reduce((best, candidate) => (
      Math.abs(CHART_RESOLUTION_STEP_MS[candidate] - gap) < Math.abs(CHART_RESOLUTION_STEP_MS[best] - gap) ? candidate : best
    ));
  }
  return barSizeFromGap(gap);
}

/**
 * The calendar period a bar falls in, numbered so that consecutive periods
 * differ by one: its month for monthly bars, its week (Monday to Sunday, UTC)
 * for weekly and anything finer. Daily and intraday bars are counted in weeks
 * because a market's own closures leave holes that are no break in the
 * series: nights, weekends, holidays (Lunar New Year and Golden Week close
 * Chinese markets for up to nine days, Eid the Gulf markets about as long),
 * and a thin listing that goes a week or two without a trade. A daily series
 * then breaks exactly where its weekly bars would.
 */
function barPeriod(time: number, interval: ManualChartResolution): number {
  if (interval !== "1mo") return Math.floor((time - FIRST_MONDAY_MS) / (7 * DAY_MS));
  const date = new Date(time);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/**
 * How many periods (`barPeriod`) in a row without a bar break the series: a
 * single month in monthly bars, since no market closes for a calendar month
 * (GF=F's monthly chart went from 2002-08 to 2002-10); three weeks for weekly
 * and finer bars, which a market's own closures do not reach.
 */
function breakGapPeriods(interval: ManualChartResolution): number {
  return interval === "1mo" ? 1 : 3;
}

/** A run of periods without a bar: the bars on either side of it, and how many periods it spans. */
interface HistoryHole {
  before: number;
  after: number;
  periods: number;
}

/**
 * The runs of periods without a bar between consecutive bars, oldest first:
 * every missing month of monthly bars and every missing week of weekly bars,
 * a closed week included, and for daily and finer bars each break in the
 * series (breakGapPeriods), since their sessions follow a calendar the bars
 * do not carry. `times` oldest first.
 */
function historyHoles(times: readonly number[], interval: ManualChartResolution): HistoryHole[] {
  const least = interval === "1mo" || interval === "1wk" ? 1 : breakGapPeriods(interval);
  const finite = times.filter(Number.isFinite);
  return finite.slice(1).flatMap((after, index) => {
    const before = finite[index]!;
    const periods = barPeriod(after, interval) - barPeriod(before, interval) - 1;
    return periods >= least ? [{ before, after, periods }] : [];
  });
}

/**
 * The breaks before each bar: `gap` after a month with no bar in monthly
 * bars, or more than three weeks in finer ones (breakGapPeriods), `jump`
 * when its close is over 100 times the last
 * close before it, or under a hundredth of it. Closes that are blank, zero or
 * negative are skipped.
 */
function historyBreakFlags(
  times: readonly number[],
  closes: readonly (number | null)[],
  interval: ManualChartResolution | null,
): string[][] {
  let previousTime: number | null = null;
  let previousClose: number | null = null;
  return times.map((time, index) => {
    const flags: string[] = [];
    if (interval && Number.isFinite(time)) {
      if (previousTime != null && barPeriod(time, interval) - barPeriod(previousTime, interval) > breakGapPeriods(interval)) flags.push("gap");
      previousTime = time;
    }
    const close = closes[index];
    if (close != null && close > 0) {
      if (previousClose != null && Math.max(close / previousClose, previousClose / close) > BREAK_JUMP_RATIO) flags.push("jump");
      previousClose = close;
    }
    return flags;
  });
}

function flagCodes(row: Pick<HistoryRow, "flag">): string[] {
  return row.flag ? row.flag.split(",") : [];
}

/** The codes of a bar left blank for prices that contradict each other: not a break before it, nor a withheld wick. */
function blankingCodes(row: Pick<HistoryRow, "flag">): string[] {
  return flagCodes(row).filter((code) => !BREAK_FLAGS.has(code) && !isWickFlag(code));
}

/**
 * Intraday bars keep their UTC time; daily and longer bars are trading dates.
 * A bar whose prices contradict each other is blanked exactly as HP blanks it,
 * and says why in `flag`. A low or high too far from the open and close to
 * have traded is left blank, the rest of the bar kept, flagged `low<close/2`
 * or `high>2*open`. A bar after a gap or a jump in the series keeps its
 * prices and is flagged `gap` or `jump`.
 */
export function historyRows(
  points: readonly PricePoint[],
  resolution: ManualChartResolution | null,
  currency: string | null = null,
  unit: string | null = null,
  volume: HistoryVolume | null = null,
  /** The listing's `quotedPriceDivisor`: prices served in pence are cleaned in pence. */
  priceDivisor = 1,
): HistoryRow[] {
  const times = points.map(getPricePointTimestamp);
  const intraday = resolution ? isIntradayResolution(resolution) : looksIntraday(times);
  const interval = historyInterval(times, resolution);
  // The latest trade some sources end intraday bars with is part of the bar before it, with no volume of its own.
  const latestTrade = intraday ? latestTradeIndex(times) : -1;
  const rows = points.map((point, index) => {
    const time = times[index]!;
    const iso = Number.isFinite(time) ? new Date(time).toISOString() : "";
    const values = pricePointValues(point);
    const flags = [...pricePointIntegrityFlags(point), ...pricePointWickFlags(point)];
    const price = (value: number | null) => value == null ? null : cleanBarPrice(value, priceDivisor);
    return {
      date: intraday ? iso.replace(".000Z", "Z") : iso.slice(0, 10),
      open: price(values.open),
      high: price(values.high),
      low: price(values.low),
      close: price(values.close),
      volume: values.volume,
      currency,
      unit,
      interval,
      flag: flags.length > 0 ? flags.join(",") : null,
      ...(point.partial ? { partial: true as const } : {}),
      ...(point.filled ? { filled: true as const } : {}),
      ...(point.unsettled ? { unsettled: true as const } : {}),
      ...(volume ? { volumeUnit: volume.unit } : {}),
      ...(values.volume == null && point.venueVolume
        ? { venueVolume: point.venueVolume.volume, volumeVenue: point.venueVolume.venue }
        : {}),
      ...(values.volume != null && point.volumeBasis ? { volumeBasis: point.volumeBasis } : {}),
      // A coin trades every day, so a bar without volume says why.
      ...(volume && values.volume == null
        ? {
          volumeNote: index === latestTrade ? "latest trade" : point.partial ? "day in progress"
            : point.filled ? "rebuilt from hourly bars" : "not reported",
        }
        : {}),
    };
  });
  const breaks = historyBreakFlags(times, rows.map((row) => row.close), interval);
  const thin = thinVolumeBars(rows.map((row, index) => ({ ...row, contract: points[index]!.contract })));
  let contract: string | null = null;
  return rows.map((row, index) => {
    const flags = [...flagCodes(row), ...breaks[index]!];
    const own = points[index]!.contract;
    // A roll is a change between two known contracts; a bar naming none (before the source knew) is no roll.
    const rolled = !!own && contract != null && own !== contract;
    if (own) contract = own;
    const marked = {
      ...row,
      ...(own ? { contract: own } : {}),
      ...(rolled ? { roll: true as const } : {}),
      ...(thin[index] ? { thin: true as const } : {}),
    };
    return flags.length > 0 ? { ...marked, flag: flags.join(",") } : marked;
  });
}

/** Bars on each side of a bar whose volumes it is held against. */
const THIN_NEIGHBOURS = 5;
/** A bar under this share of its neighbours' median volume traded thin. */
const THIN_VOLUME_SHARE = 0.05;

/**
 * For each bar of a continuous future, whether it traded far below the bars
 * around it: a volume under THIN_VOLUME_SHARE of the median of up to
 * THIN_NEIGHBOURS bars either side that have one (at least four). NG=F's
 * 2026-10-28 bar on 15 lots between days of 150,000 is a price few trades
 * made. Only a bar naming its contract is judged, against others that do: a
 * stock's or a coin's quiet day is not a contract's thin one. A bar still
 * forming, or with no trade at all (no volume, or 0), is not judged.
 */
function thinVolumeBars(rows: readonly (Pick<HistoryRow, "volume" | "partial"> & { contract?: string })[]): boolean[] {
  const judged = (row: (typeof rows)[number]): row is (typeof rows)[number] & { volume: number } =>
    !!row.contract && !row.partial && row.volume != null && Number.isFinite(row.volume) && row.volume > 0;
  return rows.map((row, index) => {
    if (!judged(row)) return false;
    const around = [...rows.slice(Math.max(0, index - THIN_NEIGHBOURS), index), ...rows.slice(index + 1, index + 1 + THIN_NEIGHBOURS)]
      .filter(judged)
      .map((other) => other.volume)
      .sort((left, right) => left - right);
    if (around.length < 4) return false;
    const middle = around.length / 2;
    const median = around.length % 2 ? around[Math.floor(middle)]! : (around[middle - 1]! + around[middle]!) / 2;
    return median > 0 && row.volume < THIN_VOLUME_SHARE * median;
  });
}

/** A roll of a continuous future: the bar it rolled at, and the contracts either side. */
interface HistoryRoll {
  date: string;
  from: string;
  to: string;
}

/** Every roll in a history's bars (`roll`), oldest first. */
function historyRolls(rows: readonly Pick<HistoryRow, "date" | "contract" | "roll">[]): HistoryRoll[] {
  let contract: string | null = null;
  const rolls: HistoryRoll[] = [];
  for (const row of rows) {
    if (row.roll && contract && row.contract) rolls.push({ date: row.date, from: contract, to: row.contract });
    if (row.contract) contract = row.contract;
  }
  return rolls;
}

/**
 * A history's bars split at every roll, each run one contract's, oldest
 * first: what a drawdown or a change is read within, never across a roll.
 * One run, named by no contract, for a history that names none.
 */
function historyContractRuns<Row extends Pick<HistoryRow, "contract" | "roll">>(rows: readonly Row[]): Array<{ contract: string | null; rows: Row[] }> {
  const runs: Array<{ contract: string | null; rows: Row[] }> = [];
  for (const row of rows) {
    const current = runs.at(-1);
    if (!current || row.roll) runs.push({ contract: row.contract ?? null, rows: [row] });
    else {
      current.rows.push(row);
      current.contract ??= row.contract ?? null;
    }
  }
  return runs;
}

/**
 * The largest drawdown of a history's bars within one contract: each run
 * between rolls read on its own (historyContractRuns), the deepest kept and
 * named by its contract when the bars roll. A history naming no contract is
 * one run, its drawdown `maxDrawdown`'s.
 */
export function historyContractDrawdown(
  rows: readonly Pick<HistoryRow, "date" | "close" | "contract" | "roll">[],
): { drawdown: MaxDrawdown; contract: string | null } | null {
  const runs = historyContractRuns(rows);
  let deepest: { drawdown: MaxDrawdown; contract: string | null } | null = null;
  for (const run of runs) {
    const drawdown = maxDrawdown(run.rows);
    if (drawdown && (!deepest || drawdown.drawdown < deepest.drawdown.drawdown)) deepest = { drawdown, contract: runs.length > 1 ? run.contract : null };
  }
  return deepest;
}

/**
 * "NG=F is the front month: rolled from NGX26 to NGZ26 on 2026-10-26 (marked
 * roll)": the rolls a continuous future's bars make, the latest few by date,
 * the rest counted. Null without one.
 */
export function historyRollNote(symbol: string, rows: readonly Pick<HistoryRow, "date" | "contract" | "roll">[]): string | null {
  const rolls = historyRolls(rows);
  if (rolls.length === 0) return null;
  const shown = rolls.slice(-LISTED_GAPS);
  const earlier = rolls.length - shown.length;
  const listed = shown.map((roll) => `from ${roll.from} to ${roll.to} on ${historyDate(roll.date)}`);
  return `${symbol} is the front month: ${earlier > 0 ? `${earlier} earlier ${earlier === 1 ? "roll" : "rolls"}, then ` : ""}`
    + `rolled ${listItems(listed)} (marked roll); drawdowns are read within one contract`;
}

/**
 * "2026-10-28 traded thin: under 5% of the volume of the bars around it", the
 * bars marked `thin`, the latest few by date. Null without one.
 */
export function historyThinNote(rows: readonly Pick<HistoryRow, "date" | "thin">[]): string | null {
  const thin = rows.filter((row) => row.thin).map((row) => historyDate(row.date));
  if (thin.length === 0) return null;
  const shown = thin.slice(-LISTED_GAPS);
  const earlier = thin.length - shown.length;
  const dates = listItems([...earlier > 0 ? [`${earlier} earlier ${earlier === 1 ? "bar" : "bars"}`] : [], ...shown]);
  return `${dates} traded thin: under ${THIN_VOLUME_SHARE * 100}% of the volume of the bars around ${thin.length === 1 ? "it" : "them"}`;
}

/**
 * The newest weekly or monthly bar while its period has not ended at `now`
 * (barPeriodToDate): marked `partial`, as a bar its source marks is, with
 * how far into its period it runs, which the status line names (`month to
 * date, through Thu 15 Oct 2026`). Daily and intraday bars are left as the
 * source marks them. Null when the newest bar is complete.
 */
export function formingPeriodBar(
  rows: readonly HistoryRow[],
  venue: string | undefined,
  now = Date.now(),
): { rows: HistoryRow[]; periodToDate: BarPeriodToDate } | null {
  const last = rows.at(-1);
  const period = last?.interval === "1mo" ? "month" : last?.interval === "1wk" ? "week" : null;
  const forming = last && period ? barPeriodToDate(last.date, period, venue, now) : null;
  if (!forming) return null;
  return { rows: [...rows.slice(0, -1), { ...last!, partial: true }], periodToDate: forming };
}

/**
 * The day the newest weekly or monthly bar closed on once its period has
 * ended (barLastSession), which dates the history instead of the day its
 * period starts: Fri 16 Oct 2026 for the week of Mon 12 Oct. Null while it
 * forms (formingPeriodBar), and for daily and intraday bars.
 */
export function closedPeriodBarDay(
  rows: readonly HistoryRow[],
  venue: string | undefined,
  now = Date.now(),
): string | null {
  const last = rows.at(-1);
  const period = last?.interval === "1mo" ? "month" : last?.interval === "1wk" ? "week" : null;
  return last && period && !barPeriodToDate(last.date, period, venue, now) ? barLastSession(last.date, period, venue, now) : null;
}

/**
 * The volume of a coin's history: traded value in the quote currency the
 * prices are in. Null for anything else, whose volume stays unlabelled.
 */
export function historyVolume(
  unit: HistoryUnit,
  market: { listing: string; exchange?: string; instrumentType?: string },
): HistoryVolume | null {
  const coin = isRoundTheClockCoin(market.listing, market.exchange) || classifyInstrumentType(market.instrumentType) === "crypto";
  return coin && unit.kind === "currency" && unit.currency ? { unit: unit.currency } : null;
}

/**
 * `volume in USD per UTC day` for a coin's daily bars, `volume in USD` for others, with what it counts when every bar
 * with a volume says the same (`historyVolumeBasis`): `volume in USD per UTC day, aggregate across venues`, `volume in
 * USD summed over 3 spot venues`.
 */
export function historyVolumeText(volume: HistoryVolume, interval: ManualChartResolution | null, basis: string | null = null): string {
  const text = interval === "1d" ? `volume in ${volume.unit} per UTC day` : `volume in ${volume.unit}`;
  if (!basis) return text;
  return basis === "aggregate" ? `${text}, aggregate across venues` : `${text} summed over ${basis}`;
}

/** What the volume of every bar that has one counts, when they all say the same; null otherwise. */
export function historyVolumeBasis(rows: readonly Pick<HistoryRow, "volume" | "volumeBasis">[]): string | null {
  const bases = new Set(rows.filter((row) => row.volume != null).map((row) => row.volumeBasis ?? null));
  const [basis] = bases.size === 1 ? [...bases] : [null];
  return basis ?? null;
}

function listDates(dates: readonly string[]): string {
  const shown = dates.slice(-LISTED_GAPS);
  const earlier = dates.length - shown.length;
  const items = [...earlier > 0 ? [`${earlier} earlier`] : [], ...shown];
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}

/** The venue's day in session at `now`: null when it is not trading, undefined when its hours are not known. */
export function venueTradingDay(venue: string | undefined, now: number): string | null | undefined {
  const zone = venue ? sessionCalendarTimeZone(venue) : null;
  const trading = zone ? isRegularSessionTime(venue, now) : null;
  if (!zone || trading === null) return undefined;
  return trading ? zonedDateKey(now, zone) : null;
}

/**
 * What the partial, filled and unsettled bars are: "2026-10-12 is still
 * forming (partial), with no volume until the day closes", a day whose
 * session has closed that "closes on the session's last price until the
 * day's bar is final (partial)", the bars rebuilt from hourly bars, a
 * future's closed session that "closes on its last trade until its
 * settlement is confirmed (unsettled)", and the latest trade an intraday
 * history ends with when it has no volume (latestTradeIndex). Null when no
 * bar is any of them. `tradingDay`: the venue's day in session now, null
 * when none is; left out when the venue's hours are not known, every
 * partial bar is then still forming.
 */
export function historyBarStatusNote(
  rows: readonly Pick<HistoryRow, "date" | "partial" | "filled" | "unsettled" | "volume" | "interval">[],
  options: { tradingDay?: string | null } = {},
): string | null {
  // A day's bar the data service still marks partial once its session has closed: its own daily bar is not in yet.
  const closed = (row: (typeof rows)[number]) =>
    options.tradingDay !== undefined && row.interval === "1d" && row.date.slice(0, 10) !== options.tradingDay;
  const partial = rows.filter((row) => row.partial && !closed(row));
  const settling = rows.filter((row) => row.partial && closed(row));
  const latest = rows[latestTradeIndex(rows.map((row) => Date.parse(row.date)))];
  const filled = rows.filter((row) => row.filled);
  const unsettled = rows.filter((row) => row.unsettled);
  const notes = [
    partial.length > 0
      ? `${listDates(partial.map((row) => row.date))} ${partial.length === 1 ? "is" : "are"} still forming (partial)`
        + (partial.every((row) => row.volume == null) ? ", with no volume until the day closes" : "")
      : null,
    settling.length > 0
      ? `${listDates(settling.map((row) => row.date))} ${settling.length === 1 ? "closes" : "close"} on the session's last price`
        + ` until the day's bar is final (partial)` + (settling.every((row) => row.volume == null) ? ", with no volume until then" : "")
      : null,
    filled.length > 0
      ? `${listDates(filled.map((row) => row.date))} ${filled.length === 1 ? "was" : "were"} rebuilt from hourly bars (filled)`
        + (filled.every((row) => row.volume == null) ? ", without volume" : "")
      : null,
    unsettled.length > 0
      ? `${listDates(unsettled.map((row) => row.date))} ${unsettled.length === 1 ? "closes" : "close"} on the last trade until the`
        + ` settlement is confirmed (unsettled)`
      : null,
    // Its blank volume beside bars that have one, said once rather than counted as a bar without volume.
    latest && latest.volume == null && historyReportsVolume(rows)
      ? `${latest.date} is the latest trade, inside the bar before it, with no volume of its own`
      : null,
  ].filter((note): note is string => note != null);
  return notes.length > 0 ? notes.join("; ") : null;
}

/**
 * Whether a history reports volume at all. An index or a currency pair has none, so its blank column says nothing;
 * a history that does marks each bar without one (`MISSING_VOLUME_TEXT`).
 */
export function historyReportsVolume(rows: readonly Pick<HistoryRow, "volume">[]): boolean {
  return rows.some((row) => row.volume != null);
}

/**
 * "2 of 177 bars have no reported volume (\u2014)" for a history that reports volume, or null. A bar still forming,
 * rebuilt from hourly bars or left blank for contradictory prices, and the latest trade an intraday history ends with,
 * are said by their own notes and not counted.
 */
export function historyMissingVolumeNote(
  rows: readonly Pick<HistoryRow, "date" | "volume" | "venueVolume" | "partial" | "filled" | "flag">[],
): string | null {
  if (!historyReportsVolume(rows)) return null;
  const latestTrade = latestTradeIndex(rows.map((row) => Date.parse(row.date)));
  const missing = rows.filter((row, index) => row.volume == null && row.venueVolume == null && !row.partial && !row.filled
    && blankingCodes(row).length === 0 && index !== latestTrade).length;
  return missingVolumeNotice(missing, rows.length) ?? null;
}

/**
 * "9 of 9 bars count IEX trades only, not the market's volume" when bars carry one venue's count in place of the
 * market's (`venueVolume`), or null.
 */
export function historyVenueVolumeNote(rows: readonly Pick<HistoryRow, "venueVolume" | "volumeVenue">[]): string | null {
  const counted = rows.filter((row) => row.venueVolume != null);
  if (!counted.length) return null;
  const venues = [...new Set(counted.map((row) => row.volumeVenue).filter(Boolean))].join(", ") || "one venue";
  const one = counted.length === 1;
  return `${counted.length} of ${rows.length} ${one && rows.length === 1 ? "bar" : "bars"} ${one ? "counts" : "count"} ${venues} trades only, `
    + "not the market's volume";
}

function neededDecimals(value: number, cap: number): number {
  for (let decimals = 0; decimals < cap; decimals++) {
    if (Number(value.toFixed(decimals)) === value) return decimals;
  }
  return cap;
}

/**
 * One decimal count for the whole table so the price columns line up: the
 * count nine in ten prices need, so a stray long value does not widen every
 * row. A known asset kind caps it with the app's price display rules; without
 * one, the largest price sets a seven significant digit ceiling (BTC keeps
 * cents, FX keeps pips, sub-cent coins keep their digits). Cents at least above 1.
 * Prices served in a sub-unit (`priceDivisor` 100, a London line's pence) may
 * keep a tenth of it too: 6.385 for 638.5p. Finer ticks stay in the export.
 */
export function historyPriceDecimals(
  rows: readonly Pick<HistoryRow, typeof PRICE_KEYS[number]>[],
  assetCategory?: string,
  priceDivisor = 1,
): number {
  const values = rows.flatMap((row) => PRICE_KEYS.flatMap((key) => {
    const value = row[key];
    return value != null && Number.isFinite(value) && value !== 0 ? [Math.abs(value)] : [];
  }));
  if (!values.length) return 2;
  const largest = values.reduce((max, value) => Math.max(max, value), 0);
  const magnitude = Math.floor(Math.log10(largest));
  const significantCap = largest >= 1 ? Math.max(2, 6 - magnitude) : 6 - magnitude;
  // A line priced in pence is a share or a fund on its exchange, whatever kind its row was saved as.
  const subUnit = priceDivisor > 1;
  const kind = subUnit && resolveAssetDisplayKind({ assetCategory }) === "other" ? "EQUITY" : assetCategory;
  const cap = resolveAssetDisplayKind({ assetCategory: kind }) === "other"
    ? significantCap
    : Math.min(significantCap, marketPriceFractionDigitCeiling(largest, { assetCategory: kind }) + (subUnit ? SUB_UNIT_SHOWN_DECIMALS : 0));
  const needed = values.map((value) => neededDecimals(value, cap)).sort((left, right) => left - right);
  const decimals = needed[Math.floor(0.9 * (needed.length - 1))]!;
  return largest >= 1 ? Math.max(2, decimals) : decimals;
}

/** A bar's prices as a table lists them; a bar without a close adds nothing to the decimals. */
interface BarPrices {
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
}

/**
 * The decimals one table of bars prints its prices with (`history`, HP's pane
 * and `fn HP`): historyPriceDecimals over the float32-cleaned prices, so a
 * feed's 4013.39990234 reads as the 4013.4 it is and the count follows the
 * asset's display rules (two for gold, three for silver, cents for a US equity,
 * and a London line's pence: 6.385 for 638.5p, with `priceDivisor` 100).
 */
export function barPriceDecimals(bars: readonly BarPrices[], assetCategory?: string, priceDivisor = 1): number {
  const clean = (value: number | null | undefined) => value == null ? null : cleanBarPrice(value, priceDivisor);
  return historyPriceDecimals(bars.flatMap((bar) => bar.close == null ? [] : [{
    date: "", open: clean(bar.open), high: clean(bar.high), low: clean(bar.low), close: clean(bar.close)!, volume: null,
  }]), assetCategory, priceDivisor);
}

/** A price at the table's decimal count (barPriceDecimals), within `maxWidth` when the pane gives one. */
export function formatBarPrice(value: number, decimals: number, maxWidth?: number): string {
  return formatPriceObservation(Number(value.toFixed(Math.min(20, decimals))), { minimumFractionDigits: decimals, maxWidth });
}

/** How far back ALL reaches, in whole years, from the window a history request for it asks for. */
export function historyAllRangeYears(now = new Date()): number {
  return Math.round((now.getTime() - subtractTimeRange(now, "ALL").getTime()) / (365.25 * DAY_MS));
}

/** "1D 5-minute, 1W hourly, 1M to 1Y daily, 5Y weekly, ALL monthly", from the table history requests use. */
export function historyIntervalsByRange(): string {
  const groups: Array<{ ranges: TimeRange[]; resolution: ManualChartResolution }> = [];
  for (const range of TIME_RANGES) {
    const resolution = RANGE_HISTORY_RESOLUTION[range];
    const last = groups.at(-1);
    if (last?.resolution === resolution) last.ranges.push(range);
    else groups.push({ ranges: [range], resolution });
  }
  return groups.map(({ ranges, resolution }) => (
    `${ranges.length > 1 ? `${ranges[0]} to ${ranges.at(-1)}` : ranges[0]} ${BAR_INTERVAL_LABELS[resolution]}`
  )).join(", ");
}

export interface HistoryUnit {
  kind: "currency" | "pair" | "points" | "unknown";
  /** Currency code of the prices; null for index points or when no source says. */
  currency: string | null;
  /** What one price is: "USD", "ILA (agorot, 1/100 ILS)", "ZAR per USD", "index points"; null when unknown. */
  unit: string | null;
}

/**
 * What the prices are in. An FX pair is named by its listing (ZAR=X is ZAR per
 * USD; EURUSD=X, EUR/USD and EURUSD:CCY are USD per EUR), an index is in
 * points, and anything else is in the currency its quote states, a sub-unit
 * named as such. Without one the unit is unknown rather than guessed from the
 * exchange.
 */
export function historyUnit(listing: string, quote: { currency?: string; instrumentType?: string } | null | undefined): HistoryUnit {
  const pair = currencyPairCode(listing.trim().toUpperCase());
  if (pair) {
    const [base, counter] = [pair.slice(0, 3), pair.slice(3)];
    return { kind: "pair", currency: counter, unit: `${counter} per ${base}` };
  }
  if (isIndexLevel(quote?.instrumentType)) return { kind: "points", currency: null, unit: INDEX_POINTS_EXPORT_UNIT };
  const code = quote?.currency?.trim();
  return code
    ? { kind: "currency", currency: code, unit: currencyUnitLabel(code, { ofMajor: true }) }
    : { kind: "unknown", currency: null, unit: null };
}

function historyDate(value: string): string {
  return value.length > 10 ? formatUtcTime(value) : value;
}

/** The first bar after the series' last gap or jump, which reads on without a break; null when it has none. */
export function historyUnbrokenFrom(rows: readonly Pick<HistoryRow, "date" | "flag">[]): string | null {
  const last = rows.findLastIndex((row) => flagCodes(row).some((code) => BREAK_FLAGS.has(code)));
  return last >= 0 ? rows[last]!.date : null;
}

/**
 * The facts line under a history heading: "Currency USD", "daily bars",
 * "2025-10-09 to 2026-10-08", "251 bars", and "unbroken from 1992-12-01"
 * after a gap or jump.
 */
export function historyFacts(unit: HistoryUnit, rows: readonly Pick<HistoryRow, "date" | "interval" | "flag">[]): string[] {
  const first = rows[0]?.date;
  const last = rows.at(-1)?.date;
  const interval = rows[0]?.interval;
  const unbroken = historyUnbrokenFrom(rows);
  return [
    unit.kind === "pair" ? unit.unit! : unit.kind === "points" ? INDEX_POINTS_LABEL : `Currency ${unit.unit ?? "unknown"}`,
    interval ? `${BAR_INTERVAL_LABELS[interval]} bars` : "",
    first && last ? (first === last ? historyDate(first) : `${historyDate(first)} to ${historyDate(last)}`) : "",
    `${rows.length} ${rows.length === 1 ? "bar" : "bars"}`,
    unbroken ? `unbroken from ${historyDate(unbroken)}` : "",
  ].filter(Boolean);
}

/** Whether a first bar dated `firstDate` lies well after the start of `range`: more than a few bars, weekends and holidays aside. */
function startsLate(range: TimeRange, interval: ManualChartResolution | null, firstDate: string, now: number): boolean {
  const first = Date.parse(firstDate);
  const tolerance = Math.max(LATE_START_MIN_MS, LATE_START_MIN_BARS * CHART_RESOLUTION_STEP_MS[interval ?? RANGE_HISTORY_RESOLUTION[range]]);
  return Number.isFinite(first) && first - subtractTimeRange(new Date(now), range).getTime() > tolerance;
}

/**
 * Where an ALL history starts when that is its source's first bar, well
 * after the window ALL reaches back to (historyAllRangeYears): BTC-USD's
 * monthly bars start 2014-09, though it traded from 2010. A monthly bar's
 * month, otherwise its day. Null for other ranges, and for a history the
 * window cuts.
 */
export function historyAllStart(
  range: TimeRange,
  interval: ManualChartResolution | null,
  firstDate: string | undefined,
  now = Date.now(),
): string | null {
  if (range !== "ALL" || !firstDate || !startsLate(range, interval, firstDate, now)) return null;
  return interval === "1mo" ? firstDate.slice(0, 7) : firstDate.slice(0, 10);
}

/** "ALL starts 2014-09; the source has no earlier bar", for the start historyAllStart finds. */
export function historyAllStartNote(start: string): string {
  return `ALL starts ${start}; the source has no earlier bar`;
}

/**
 * What an export should know that its rows do not show: bars coarser than the
 * range is served in, a first bar well after the start asked for, as for a
 * listing younger than the range, and where an ALL history starts when that
 * is the source's first bar, unless a coverage line already says where the
 * source starts (`coverageStated`). Weekends and holidays are within tolerance.
 */
export function historyNotes(
  range: TimeRange,
  interval: ManualChartResolution | null,
  firstDate: string | undefined,
  now = Date.now(),
  coverageStated = false,
): string[] {
  if (!firstDate) return [];
  const notes: string[] = [];
  const expected = RANGE_HISTORY_RESOLUTION[range];
  if (interval && CHART_RESOLUTION_STEP_MS[interval] > CHART_RESOLUTION_STEP_MS[expected]) {
    const from = interval === "1mo" ? firstDate.slice(0, 7) : firstDate.slice(0, 10);
    notes.push(`Asked ${range}, got ${BAR_INTERVAL_LABELS[interval]} bars from ${from}`);
  }
  if (range !== "ALL" && startsLate(range, interval, firstDate, now)) {
    notes.push(`Asked ${range}, data starts ${firstDate.slice(0, 10)} (first available bar)`);
  }
  const allStart = coverageStated ? null : historyAllStart(range, interval, firstDate, now);
  if (allStart) notes.push(historyAllStartNote(allStart));
  return notes;
}

/**
 * "Price history starts 1992-12-01; old-shekel quotes before 1992 are not
 * served.": the source serves nothing before a date the range reaches back
 * past, and why when it says. Null for a range that starts after it.
 */
export function historyCoverageWarning(
  range: TimeRange,
  coverage: { coverageStart?: string; coverageNote?: string },
  now = Date.now(),
): string | null {
  return historyCoverageNotice(coverage.coverageStart, subtractTimeRange(new Date(now), range).getTime(), coverage.coverageNote);
}

/** Gaps listed by date before the rest are only counted. */
const LISTED_GAPS = 3;

function listItems(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function monthKey(year: number, month: number): string {
  return utcDay(Date.UTC(year, month, 1)).slice(0, 7);
}

/** The first day of week `period` (`barPeriod`): its Monday. */
function weekStart(period: number): number {
  return FIRST_MONDAY_MS + period * 7 * DAY_MS;
}

/** "2026-02", "2026-02 to 2026-03 (2 months)", "the week of 2025-09-29", "2015-06-27 to 2015-08-02 (5 weeks)". */
function holeText(hole: HistoryHole, interval: ManualChartResolution): string {
  const { before, after, periods } = hole;
  if (interval === "1mo") {
    const period = barPeriod(before, interval) + 1;
    const first = monthKey(Math.floor(period / 12), period % 12);
    const last = monthKey(Math.floor((period + periods - 1) / 12), (period + periods - 1) % 12);
    return periods === 1 ? first : `${first} to ${last} (${periods} months)`;
  }
  const length = `${periods} week${periods === 1 ? "" : "s"}`;
  if (interval === "1wk") {
    const first = barPeriod(before, interval) + 1;
    return periods === 1 ? `the week of ${utcDay(weekStart(first))}`
      : `${utcDay(weekStart(first))} to ${utcDay(weekStart(first + periods) - DAY_MS)} (${length})`;
  }
  return `${utcDay(before + DAY_MS)} to ${utcDay(after - DAY_MS)} (${length})`;
}

/**
 * "No bar for 2026-02", "No bars for 2001-07, 2002-09 and 2026-02 to 2026-03
 * (2 months)": every run of periods without a bar (historyHoles), oldest
 * first, each named. `times` oldest first. Null when there is none.
 */
export function historyMissingPeriodsNote(times: readonly number[], interval: ManualChartResolution | null): string | null {
  const holes = interval ? historyHoles(times, interval) : [];
  if (!interval || holes.length === 0) return null;
  const one = holes.length === 1 && holes[0]!.periods === 1 && (interval === "1mo" || interval === "1wk");
  return `${one ? "No bar" : "No bars"} for ${listItems(holes.map((hole) => holeText(hole, interval)))}`;
}

/** A bar's date as a history table shows it: the month of a monthly bar, the day of a daily or weekly one, else the UTC time. */
function holeBarDate(time: number, interval: ManualChartResolution): string {
  const iso = new Date(time).toISOString();
  return interval === "1mo" ? iso.slice(0, 7) : isIntradayResolution(interval) ? formatUtcTime(iso) : iso.slice(0, 10);
}

/**
 * For each bar, oldest first, whether a run of periods without a bar
 * (historyHoles) lies between it and the bar before: its change from that
 * bar spans them. `times` oldest first.
 */
export function historyBarsAfterHole(times: readonly number[], interval: ManualChartResolution | null): boolean[] {
  const after = new Set(interval ? historyHoles(times, interval).map((hole) => hole.after) : []);
  return times.map((time) => after.has(time));
}

/**
 * "CHG marked * spans the missing bars: 2026-04 is from 2026-01": the bar
 * each change after a run of periods without a bar (historyBarsAfterHole) is
 * measured from. `times` oldest first. Null when there is none.
 */
export function historyChangeBaseNote(times: readonly number[], interval: ManualChartResolution | null): string | null {
  const holes = interval ? historyHoles(times, interval) : [];
  if (!interval || holes.length === 0) return null;
  const bases = holes.map(({ before, after }, index) =>
    `${holeBarDate(after, interval)}${index === 0 ? " is" : ""} from ${holeBarDate(before, interval)}`);
  return `CHG marked * spans the missing bars: ${listItems(bases)}`;
}

/**
 * "No bars for 1980-08 to 1992-11 (148 months)": every run of periods with
 * no bar between two bars (historyMissingPeriodsNote).
 */
function historyBreakGapNote(rows: readonly Pick<HistoryRow, "date" | "interval" | "flag">[]): string | null {
  return historyMissingPeriodsNote(rows.map((row) => Date.parse(row.date)), rows[0]?.interval ?? null);
}

const closeFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 7, useGrouping: false });

/**
 * "Close rises 564x from 0.0049 on 1980-07-01 to 2.763 on 1992-12-01": each
 * bar flagged `jump`, against the last close before it. Neutral on the cause,
 * which can be a change of unit, a different series or a real collapse.
 */
export function historyJumpNote(rows: readonly Pick<HistoryRow, "date" | "close" | "flag">[]): string | null {
  const jumps: string[] = [];
  let previous: { date: string; close: number } | null = null;
  for (const row of rows) {
    if (row.close == null || !(row.close > 0)) continue;
    if (previous && flagCodes(row).includes("jump")) {
      const rises = row.close > previous.close;
      const ratio = Math.round(rises ? row.close / previous.close : previous.close / row.close).toLocaleString("en-US");
      jumps.push(`${rises ? "rises" : "falls"} ${ratio}x from ${closeFormat.format(previous.close)} on ${historyDate(previous.date)}`
        + ` to ${closeFormat.format(row.close)} on ${historyDate(row.date)}`);
    }
    previous = { date: row.date, close: row.close };
  }
  if (jumps.length === 0) return null;
  const shown = jumps.slice(-LISTED_GAPS);
  const earlier = jumps.length - shown.length;
  return `Close ${earlier > 0 ? `jumps over 100x at ${earlier} earlier ${earlier === 1 ? "bar" : "bars"}, then ` : ""}${listItems(shown)}`;
}

/**
 * "No bar for 2026-10-10": the days a coin, which trades every day, has no
 * daily bar for between its first and last bar. Days before the first bar are
 * before the listing. A market that closes skips weekends and holidays, so its
 * daily gaps say nothing on their own: for it, and for a coin's other bar
 * sizes, the note names every month or week without a bar and each break in
 * daily or finer bars (historyMissingPeriodsNote), "No bar for 2026-02".
 */
export function historyGapNote(
  rows: readonly Pick<HistoryRow, "date" | "interval" | "flag">[],
  market: { listing: string; exchange?: string; instrumentType?: string },
): string | null {
  const everyDay = isRoundTheClockCoin(market.listing, market.exchange)
    || classifyInstrumentType(market.instrumentType) === "crypto";
  if (!everyDay || rows[0]?.interval !== "1d") return historyBreakGapNote(rows);
  const days = new Set(rows.map((row) => Date.parse(`${row.date.slice(0, 10)}T00:00:00Z`)).filter(Number.isFinite));
  const sorted = [...days].sort((left, right) => left - right);
  const gaps: Array<[number, number]> = [];
  for (const [index, day] of sorted.slice(1).entries()) {
    const previous = sorted[index]!;
    if (day - previous > DAY_MS) gaps.push([previous + DAY_MS, day - DAY_MS]);
  }
  if (!gaps.length) return null;
  const date = (time: number) => new Date(time).toISOString().slice(0, 10);
  const length = (gaps: Array<[number, number]>) => gaps.reduce((count, [from, to]) => count + (to - from) / DAY_MS + 1, 0);
  // The latest gaps by date, the rest as a count.
  const shown = gaps.slice(-LISTED_GAPS);
  const earlier = length(gaps) - length(shown);
  const listed = [
    ...earlier > 0 ? [`${earlier} earlier ${earlier === 1 ? "day" : "days"}`] : [],
    ...shown.map(([from, to]) => from === to ? date(from) : `${date(from)} to ${date(to)}`),
  ];
  return `${length(gaps) === 1 ? "No bar" : "No bars"} for ${listItems(listed)}`;
}

/**
 * "37 of 251 bars have high below open or close in the source data; ...", or
 * null when every bar agrees. Bars flagged only for a gap or jump before them
 * keep their prices and are not counted.
 */
export function historyFlagNote(rows: readonly Pick<HistoryRow, "flag">[]): string | null {
  const flagged = rows.filter((row) => blankingCodes(row).length > 0);
  if (flagged.length === 0) return null;
  const codes = new Set(flagged.flatMap(blankingCodes));
  const kinds = [
    codes.has("high<open") || codes.has("high<close") ? "high below open or close" : "",
    codes.has("low>open") || codes.has("low>close") ? "low above open or close" : "",
    codes.has("low>high") ? "low above high" : "",
  ].filter(Boolean);
  const count = `${flagged.length} of ${rows.length} ${flagged.length === 1 && rows.length === 1 ? "bar" : "bars"}`;
  return `${count} ${flagged.length === 1 ? "has" : "have"} ${kinds.join(", or ")} in the source data; their prices are left blank`;
}

/**
 * "The low of 2021-11-29 is under half its open and close, too far to have
 * traded; left blank and out of ranges", or null when no bar has such a wick
 * (pricePointWickFlags). Three or more bars are counted.
 */
export function historyWickNote(rows: readonly Pick<HistoryRow, "date" | "flag">[]): string | null {
  const flagged = rows.filter((row) => flagCodes(row).some(isWickFlag));
  if (flagged.length === 0) return null;
  const sides = new Set(flagged.flatMap((row) => flagCodes(row).filter(isWickFlag).map((code) => code.slice(0, code.indexOf(code.startsWith("low") ? "<" : ">")))));
  const reason = "too far to have traded; left blank and out of ranges";
  const only = flagged[0]!;
  if (flagged.length === 1 && sides.size === 1) {
    return sides.has("low") ? `The low of ${only.date} is under half its open and close, ${reason}`
      : `The high of ${only.date} is over twice its open and close, ${reason}`;
  }
  const kinds = [sides.has("low") ? "a low under half" : "", sides.has("high") ? "a high over twice" : ""].filter(Boolean).join(" or ");
  const dates = flagged.length <= LISTED_GAPS ? ` (${listItems(flagged.map((row) => row.date))})` : "";
  return `${flagged.length} of ${rows.length} bars have ${kinds} their open and close${dates}, ${reason}`;
}
