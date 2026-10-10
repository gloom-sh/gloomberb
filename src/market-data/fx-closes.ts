import type { CloudMarketResponse, CloudPricePointPayload } from "../api-client/types";
import type { FxLeg } from "./coordinator/fx-legs";

/** USD per unit of one currency at each completed daily FX close, by date. */
export interface FxCloses {
  currency: string;
  closes: ReadonlyMap<string, number>;
  first: string;
  asOf: string;
}

/** Why a daily FX history cannot be used: no usable closes, or none in the last week. */
export class FxHistoryError extends Error {
  constructor(readonly problem: "unavailable" | "stale") {
    super(problem === "stale" ? "Daily FX history is stale" : "Daily FX history unavailable");
    this.name = "FxHistoryError";
  }
}

const DAY_MS = 86_400_000;
/** A pair's latest completed close older than this is stale; a weekend and a holiday fit well inside it. */
const FX_MAX_AGE_DAYS = 7;

const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;

/**
 * Completed daily closes of the pair as USD per unit, today's still-trading
 * bar left out. A malformed row, two different closes on one date, or more
 * rows than asked for rejects the whole history rather than a part of it.
 */
export function dailyFxCloses(
  response: CloudMarketResponse<CloudPricePointPayload[]>,
  leg: FxLeg,
  now = new Date(),
  maxRows = 1500,
): FxCloses {
  if (response.status !== "success" || !Array.isArray(response.data) || response.data.length < 2) throw new FxHistoryError("unavailable");
  if (response.stale || response.providerMeta?.stale) throw new FxHistoryError("stale");
  if (response.data.length > maxRows) throw new FxHistoryError("unavailable");
  const today = now.toISOString().slice(0, 10);
  const closes = new Map<string, number>();
  for (const row of response.data) {
    if (!row || typeof row.date !== "string" || !Number.isFinite(Date.parse(row.date)) || !isDay(row.date.slice(0, 10))
      || !Number.isFinite(row.close) || row.close <= 0) throw new FxHistoryError("unavailable");
    const date = new Date(row.date).toISOString().slice(0, 10);
    if (date >= today) continue;
    const rate = leg.invert ? 1 / row.close : row.close;
    const previous = closes.get(date);
    if (previous != null && previous !== rate) throw new FxHistoryError("unavailable");
    closes.set(date, rate);
  }
  const dates = [...closes.keys()].sort();
  const asOf = dates.at(-1);
  if (!asOf || Date.parse(today) - Date.parse(asOf) > FX_MAX_AGE_DAYS * DAY_MS) throw new FxHistoryError("stale");
  return { currency: leg.currency, closes, first: dates[0]!, asOf };
}

/**
 * The last completed close on or before `date` (YYYY-MM-DD), looking back at
 * most a week so a weekend or holiday finds the close before it but a gap in
 * the history is not bridged.
 */
export function fxCloseOnOrBefore(fx: FxCloses, date: string): { date: string; rate: number } | null {
  const end = Date.parse(`${(date < fx.asOf ? date : fx.asOf)}T00:00:00Z`);
  for (let back = 0; back <= FX_MAX_AGE_DAYS; back++) {
    const day = new Date(end - back * DAY_MS).toISOString().slice(0, 10);
    const rate = fx.closes.get(day);
    if (rate != null) return { date: day, rate };
  }
  return null;
}
