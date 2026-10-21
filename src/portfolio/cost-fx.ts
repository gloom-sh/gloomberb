import { fxLegForCurrency } from "../market-data/coordinator/fx-legs";
import { fxCloseOnDate, type FxHistoryClient } from "../market-data/fx-closes";
import { formatFxRate } from "../cli/fx-pair";
import { dateOptionError, readCalendarDate } from "../utils/calendar-date";
import { currencyUnitLabel, heldCurrencyUnit } from "../utils/currency-units";
import { readTypedNumber } from "../utils/decimal-comma";
import { logFailure } from "../utils/log-failure";
import { sameCurrency } from "./position-metrics";

/** Reads a pair's daily bars; `apiClient` in the app, a fake in tests. */
export type CostFxHistoryClient = FxHistoryClient;

/** The rate a lot's cost was bought at: one unit of its currency in the portfolio's, at a dated daily close. */
export interface CostFxReading {
  rate: number;
  /** The UTC day of the FX close it was read from: the purchase date, or the last trading day before it. */
  date: string;
}

/** Why no rate could be read for a purchase date; the command says to give one with --cost-fx instead. */
export class CostFxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostFxError";
  }
}

/**
 * USD per unit of an ISO currency at its last completed daily close on or
 * before `date`, looking back a week at most (`fxCloseOnDate`, as `fx --date`
 * reads it). Null when the pair has no close in that week.
 */
async function usdPerUnitOn(code: string, date: string, client: CostFxHistoryClient, now: Date): Promise<CostFxReading | null> {
  if (code === "USD") return { rate: 1, date };
  const leg = fxLegForCurrency(code);
  if (!leg) throw new CostFxError(`No daily FX history is served for ${code}`);
  return fxCloseOnDate(leg, date, client, now);
}

/**
 * What one unit of `from` (a lot's currency, GBp counting pence and USX cents) cost in
 * `into` (the portfolio's) at the daily FX closes of `date`, each pair's last
 * close on or before it, crossed through USD as every converted value is.
 * Throws `CostFxError` when a pair is not served or has no close in the week
 * before the date.
 */
export async function loadCostFxRate(
  from: string,
  into: string,
  date: string,
  client: CostFxHistoryClient,
  now = new Date(),
): Promise<CostFxReading> {
  const fromUnit = heldCurrencyUnit(from);
  const intoUnit = heldCurrencyUnit(into);
  const [fromUsd, intoUsd] = await Promise.all([
    usdPerUnitOn(fromUnit.currency, date, client, now),
    usdPerUnitOn(intoUnit.currency, date, client, now),
  ]);
  const missing = [fromUsd ? null : fromUnit.currency, intoUsd ? null : intoUnit.currency].filter(Boolean);
  if (!fromUsd || !intoUsd) throw new CostFxError(`No ${missing.join(" or ")} FX close in the week up to ${date}`);
  const rate = (fromUsd.rate / fromUnit.divisor) / (intoUsd.rate / intoUnit.divisor);
  if (!Number.isFinite(rate) || rate <= 0) throw new CostFxError(`No usable ${fromUnit.currency}/${intoUnit.currency} rate for ${date}`);
  // A pair that did not trade that day (its holiday) dates the cross by its own last close.
  return { rate, date: fromUsd.date < intoUsd.date ? fromUsd.date : intoUsd.date };
}

/** How the command line or the position form names the purchase date and the rate in what it says. */
export interface CostFxWording {
  /** The rate's option or field: `--cost-fx`, Cost FX. */
  rate: string;
  /** The date's option or field as a date error names it: `--date`, or empty for a form field. */
  dateOption: string;
  /** The date's option or field as a sentence names it: `--date`, Purchase Date. */
  date: string;
  /** Where to give the rate instead, for a pair such as `TRY per USD`. */
  rateInstead(pair: string): string;
  /** That the purchase date gives the rate too. */
  dateInstead: string;
}

export const CLI_COST_FX_WORDING: CostFxWording = {
  rate: "--cost-fx",
  dateOption: "--date",
  date: "--date",
  rateInstead: (pair) => `Give the rate it was bought at instead: --cost-fx <${pair}>.`,
  dateInstead: "Or give the purchase --date, and its daily FX close is used.",
};

export const FORM_COST_FX_WORDING: CostFxWording = {
  rate: "Cost FX",
  dateOption: "",
  date: "Purchase Date",
  rateInstead: (pair) => `Give the rate it was bought at in Cost FX instead, in ${pair}.`,
  dateInstead: "Or give the Purchase Date, and its daily FX close is used.",
};

/** A purchase date or cost FX rate that cannot be used, and what to give instead. */
export class PositionCostFxError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = "PositionCostFxError";
  }
}

/**
 * A typed purchase date as an ISO day, no later than today (UTC); throws
 * saying which formats it takes.
 */
export function readPurchaseDate(value: string, wording: CostFxWording, now = new Date()): string {
  const date = readCalendarDate(value);
  if (!date) throw new PositionCostFxError(dateOptionError(value, wording.dateOption, { subject: "the purchase date", now }));
  if (date > now.toISOString().slice(0, 10)) {
    throw new PositionCostFxError(`${wording.date} ${value.trim()} is after today; it is the day the position was bought.`);
  }
  return date;
}

/** A typed cost FX rate: a positive number, 32,15 read as 32.15; throws otherwise. */
export function readCostFxRate(value: string, wording: CostFxWording): number {
  const rate = readTypedNumber(value, wording.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new PositionCostFxError(`${wording.rate} is the rate the cost was bought at, a positive number such as 32.15 (TRY per USD); got "${value.trim()}".`);
  }
  return rate;
}

/**
 * The rate a position's cost was bought at, as typed or from the FX closes of
 * its purchase date, for a position held in another currency than the
 * portfolio's; undefined when neither was given or the position is in the
 * portfolio's currency (a date alone then only dates the lot). A rate typed
 * for a position in the portfolio's own currency, one that reads as a
 * mistake against today's, and a date with no FX close throw
 * PositionCostFxError saying what to give instead.
 */
export async function resolvePositionCostFx({ date, costFx, history, currency, portfolioCurrency, listing, todaysRate, wording }: {
  date?: string; costFx?: number; history: CostFxHistoryClient; currency: string; portfolioCurrency: string; listing: string;
  /** Today's rate, one unit of `currency` in `portfolioCurrency`; NaN when it cannot be read. */
  todaysRate: () => Promise<number>;
  wording: CostFxWording;
}): Promise<{ costFx: { rate: number; currency: string }; date: string | null } | undefined> {
  const foreign = !sameCurrency(currency, portfolioCurrency);
  const insteadHint = wording.rateInstead(`${portfolioCurrency} per ${currency}`);
  if (costFx != null) {
    if (!foreign) {
      const held = currency === portfolioCurrency ? currency : `${currency}, a unit of ${portfolioCurrency}`;
      throw new PositionCostFxError(`${wording.rate} converts a cost in another currency; ${listing} is held in ${held}, the portfolio's currency.`);
    }
    const today = await todaysRate().catch(logFailure("portfolio.cost-fx", "Reading today's rate to check a typed cost FX rate failed", Number.NaN));
    const problem = implausibleCostFx(costFx, today, { currency, portfolioCurrency, listing, wording });
    if (problem) throw new PositionCostFxError(problem, wording.dateInstead);
    return { costFx: { rate: costFx, currency: portfolioCurrency }, date: null };
  }
  if (!date || !foreign) return undefined;
  try {
    const reading = await loadCostFxRate(currency, portfolioCurrency, date, history);
    return { costFx: { rate: reading.rate, currency: portfolioCurrency }, date: reading.date };
  } catch (error) {
    if (error instanceof CostFxError) {
      throw new PositionCostFxError(`${error.message}, so the ${currency} cost cannot be converted at the rate of ${date}.`, insteadHint);
    }
    // Offline, signed out or a server error: say what was being read, and the way that needs no network.
    const reason = error instanceof Error ? error.message : String(error);
    throw new PositionCostFxError(`Could not read the ${currency} and ${portfolioCurrency} FX closes of ${date}: ${reason}.`, insteadHint);
  }
}

/** How far from today's rate a typed one may be: a currency that lost 99% since purchase still fits. */
const COST_FX_MAX_RATIO = 100;

/**
 * Why a typed cost FX rate reads as a mistake against today's rate, else null:
 * a rate per pound for a lot held in pence, the inverse of the pair (0.0319
 * for 31.37 TRY per USD), or more than a hundred times off either way. A
 * rate is only called inverted when today's is far from 1 and the typed one
 * lies on the other side of it, so EUR per USD near parity is never refused.
 * Null when today's rate is not known.
 */
function implausibleCostFx(
  rate: number,
  today: number,
  { currency, portfolioCurrency, listing, wording }: { currency: string; portfolioCurrency: string; listing: string; wording: CostFxWording },
): string | null {
  if (!Number.isFinite(today) || today <= 0) return null;
  const pair = `${portfolioCurrency} per ${currency}`;
  const typed = formatFxRate(rate);
  const todays = `today's is ${formatFxRate(today)} ${pair}`;
  const unit = heldCurrencyUnit(currency);
  if (unit.divisor !== 1 && rate / today >= unit.divisor / 5 && rate / today <= unit.divisor * 5) {
    const name = currency.toUpperCase() === "USX" ? "US cents" : currencyUnitLabel(currency).replace(/^\S+ \((.+)\)$/, "$1");
    return `${wording.rate} ${typed} looks like ${portfolioCurrency} per ${unit.currency}; ${listing} is held in ${currency} (${name}), `
      + `so the rate is ${pair}, 1/${unit.divisor} of that: ${todays}.`;
  }
  if ((today >= 3 && rate < 1) || (today <= 1 / 3 && rate > 1)) {
    return `${wording.rate} ${typed} looks inverted: it is the ${portfolioCurrency} paid for one ${currency}, and ${todays}.`;
  }
  if (rate / today > COST_FX_MAX_RATIO || today / rate > COST_FX_MAX_RATIO) {
    return `${wording.rate} ${typed} is more than ${COST_FX_MAX_RATIO} times off today's rate (${formatFxRate(today)} ${pair}); check the rate.`;
  }
  return null;
}
