import type { PricePoint } from "../types/financials";

type ReportedPricePoint = Readonly<Omit<PricePoint, "date" | "historySource"> & {
  date: string;
  historySource?: Readonly<NonNullable<PricePoint["historySource"]>>;
}>;

export interface PriceHistoryIntegrity {
  readonly reason: "inconsistent-ohlc";
  /** Original reported values, retained for inspection, never used as replacements. */
  readonly sourcePoints: ReadonlyArray<ReportedPricePoint>;
}

function snapshotReportedPoint(point: ReportedPricePoint): ReportedPricePoint {
  return Object.freeze({ ...point, ...(point.historySource ? { historySource: Object.freeze({ ...point.historySource }) } : {}) });
}

export function mergePriceHistoryIntegrity(...entries: readonly PriceHistoryIntegrity[]): PriceHistoryIntegrity {
  return Object.freeze({
    reason: "inconsistent-ohlc",
    sourcePoints: Object.freeze(entries.flatMap((entry) => entry.sourcePoints.map(snapshotReportedPoint))),
  });
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function above(left: number, right: number): boolean {
  return left - right > 8 * Number.EPSILON * Math.max(Math.abs(left), Math.abs(right));
}

/** Missing OHLC fields are not contradictory: close-only histories remain usable. */
export function pricePointIntegrity(point: PricePoint): PriceHistoryIntegrity | undefined {
  const { open, high, low, close } = point;
  const invalid = (finite(high) && finite(low) && above(low, high))
    || [open, close].some((value) => finite(value)
      && ((finite(high) && above(value, high)) || (finite(low) && above(low, value))));
  if (!invalid) return undefined;
  const date = new Date(point.date);
  return Object.freeze({
    reason: "inconsistent-ohlc",
    sourcePoints: Object.freeze([snapshotReportedPoint({ ...point, date: Number.isFinite(date.getTime()) ? date.toISOString() : String(point.date) })]),
  });
}

/** Calculation/display fields deliberately exclude the contradictory source row. */
export function pricePointValues(point: PricePoint, integrity = pricePointIntegrity(point)) {
  const value = (number: number | undefined) => !integrity && finite(number) ? number : null;
  return {
    open: value(point.open), high: value(point.high), low: value(point.low),
    close: value(point.close), volume: value(point.volume),
    ...(integrity ? { integrity } : {}),
  };
}

export function priceHistoryIntegrityNotice(count: number): string | undefined {
  return count > 0
    ? `${count} inconsistent OHLC ${count === 1 ? "bar is" : "bars are"} unavailable. Affected calculations contain gaps; original values and reasons are retained in JSON exports.`
    : undefined;
}
