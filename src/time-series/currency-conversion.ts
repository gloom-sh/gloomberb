import { dailyFxCloses, dailyFxLeg, FxHistoryError, fxCloseOnOrBefore, type FxCloses, type FxHistoryClient } from "../market-data/fx-closes";
import { resolveCurrencyUnit } from "../utils/currency-units";
import { logFailure } from "../utils/log-failure";
import type { ResolvedSeries, TimeSeriesPoint } from "./types";

/**
 * A comparison in one currency (`fn CMP THYAO:BIST MSFT --currency USD`): each
 * leg's prices converted at the daily FX close of their day, so a leg's return
 * carries its currency's move against the one asked for.
 */

/** USD per unit of a currency at each completed daily close from `startDate` (YYYY-MM-DD) to today. */
export type LoadFxCloses = (currency: string, startDate: string) => Promise<FxCloses>;

const DAY_MS = 86_400_000;

/** Reads a currency's daily USD closes from `startDate` to today, as `loadFxCloses` wants them. */
export async function loadDailyFxCloses(currency: string, startDate: string, client: FxHistoryClient, now = new Date()): Promise<FxCloses> {
  const leg = dailyFxLeg(currency);
  if (!leg) throw new FxHistoryError("unavailable");
  // Every weekday from a week before the start, so the first bar has the close before it.
  const from = Date.parse(`${startDate}T00:00:00Z`) - 7 * DAY_MS;
  const days = Math.max(14, Math.ceil((now.getTime() - from) / DAY_MS) + 2);
  const response = await client.getCloudHistory(leg.instrument.symbol, leg.instrument.exchange ?? "", {
    interval: "1day", startDate: new Date(from).toISOString().slice(0, 10), endDate: now.toISOString().slice(0, 10), outputsize: days,
  });
  return dailyFxCloses(response, leg, now, days + 10);
}

function scaled(value: number | null | undefined, factor: number): number | null | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value * factor : value;
}

/**
 * Prices in `from` units as prices in the target currency: each point's
 * prices times USD per `from` over USD per target at the last completed close
 * on or before its day (a USD side is 1), and over the sub-unit divisor of a
 * price in pence or cents. A point with no close in the week before it is
 * left out, not converted at another day's rate. Volume is left alone.
 */
function convertPricePoints(
  points: readonly TimeSeriesPoint[],
  { dayOf, divisor = 1, fromCloses, toCloses }: {
    dayOf: (point: TimeSeriesPoint) => string;
    divisor?: number;
    /** USD per unit of the prices' currency; null when it is USD. */
    fromCloses: FxCloses | null;
    /** USD per unit of the target; null when it is USD. */
    toCloses: FxCloses | null;
  },
): { points: TimeSeriesPoint[]; missing: number } {
  let missing = 0;
  const converted: TimeSeriesPoint[] = [];
  for (const point of points) {
    const day = dayOf(point);
    const from = fromCloses ? fxCloseOnOrBefore(fromCloses, day)?.rate : 1;
    const to = toCloses ? fxCloseOnOrBefore(toCloses, day)?.rate : 1;
    if (from == null || to == null || !(to > 0)) {
      missing += 1;
      continue;
    }
    const factor = from / to / divisor;
    converted.push({
      ...point,
      value: scaled(point.value, factor) ?? null,
      ...point.rawValue !== undefined ? { rawValue: scaled(point.rawValue, factor) ?? null } : {},
      ...point.open !== undefined ? { open: scaled(point.open, factor) } : {},
      ...point.high !== undefined ? { high: scaled(point.high, factor) } : {},
      ...point.low !== undefined ? { low: scaled(point.low, factor) } : {},
      ...point.close !== undefined ? { close: scaled(point.close, factor) } : {},
    });
  }
  return { points: converted, missing };
}

export interface CurrencySeriesOutcome {
  series: ResolvedSeries;
  /** Why the series stays in its own currency, or what it lost, when it does. */
  notice?: string;
}

/** `TRY/share` as `USD/share`: the unit's currency, in its own spelling or its sub-unit's, replaced. */
function unitIn(unit: string, priceCurrency: string, target: string): string {
  return unit.startsWith(priceCurrency) ? `${target}${unit.slice(priceCurrency.length)}` : unit;
}

/**
 * A price series in the target currency, from its listing's daily FX closes
 * and the target's. A series already in it is left as it is; one whose
 * currency is unknown or whose closes cannot be read stays in its own
 * currency, with the reason.
 */
export async function currencySeries(
  series: ResolvedSeries,
  { target, priceCurrency, loadCloses, dayOf }: {
    target: string;
    priceCurrency: string | undefined;
    loadCloses: LoadFxCloses | undefined;
    dayOf: (point: TimeSeriesPoint) => string;
  },
): Promise<CurrencySeriesOutcome> {
  const unit = resolveCurrencyUnit(priceCurrency);
  if (!unit.currency) return { series, notice: `price currency unknown; not converted to ${target}.` };
  if (unit.currency === target && unit.divisor === 1) return { series };
  const days = series.points.map(dayOf).filter(Boolean).sort();
  if (!days.length) return { series };
  const read = (currency: string) => currency === "USD" ? Promise.resolve(null)
    : loadCloses ? loadCloses(currency, days[0]!) : Promise.reject(new FxHistoryError("unavailable"));
  const [fromCloses, toCloses] = await Promise.all([
    unit.currency === target ? null : read(unit.currency),
    unit.currency === target ? null : read(target),
  ]).catch((error) => {
    logFailure("currency-conversion", "Loading daily FX closes failed", null)(error);
    return [undefined, undefined] as const;
  });
  if (fromCloses === undefined) return { series, notice: `${unit.currency}/${target} daily closes unavailable; left in ${unit.currency}.` };
  const { points, missing } = convertPricePoints(series.points, { dayOf, divisor: unit.divisor, fromCloses, toCloses: toCloses ?? null });
  const raw = priceCurrency!.trim();
  return {
    series: {
      ...series,
      points,
      unit: unitIn(series.unit, raw, target),
      ...series.rawUnit !== undefined ? { rawUnit: unitIn(series.rawUnit, raw, target) } : {},
      unitGroup: series.unitGroup.replace(/:[^:]+$/, `:${target}`),
      convertedFrom: unit.currency,
    },
    ...(missing ? { notice: `${missing} bar${missing === 1 ? "" : "s"} with no ${unit.currency}/${target} close in the week before left out.` } : {}),
  };
}
