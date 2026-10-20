import type { CloudMarketResponse, CloudPricePointPayload } from "../api-client/types";
import type { CloudHistoryParams } from "../api-client/paths";
import { fxLegForCurrency } from "../market-data/coordinator/fx-legs";
import { resolveCurrencyUnit } from "../utils/currency-units";

/** Reads a pair's daily bars; `apiClient` in the app, a fake in tests. */
export interface CostFxHistoryClient {
  getCloudHistory(symbol: string, exchange: string, params: CloudHistoryParams): Promise<CloudMarketResponse<CloudPricePointPayload[]>>;
}

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

const DAY_MS = 86_400_000;
/** How far before the purchase date a close is looked for: a weekend and a holiday fit inside it, a gap in the data does not. */
const LOOKBACK_DAYS = 7;

const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * USD per unit of an ISO currency at its last completed daily close on or
 * before `date`, looking back a week at most. Today's bar, still trading, is
 * never read. Null when the pair has no close in that week.
 */
async function usdPerUnitOn(code: string, date: string, client: CostFxHistoryClient, now: Date): Promise<CostFxReading | null> {
  if (code === "USD") return { rate: 1, date };
  const leg = fxLegForCurrency(code);
  if (!leg) throw new CostFxError(`No daily FX history is served for ${code}`);
  const day = Date.parse(`${date}T00:00:00Z`);
  const response = await client.getCloudHistory(leg.instrument.symbol, leg.instrument.exchange ?? "", {
    interval: "1day", startDate: isoDay(day - LOOKBACK_DAYS * DAY_MS), endDate: isoDay(day + DAY_MS), outputsize: LOOKBACK_DAYS + 4,
  });
  if (response.status !== "success" && response.status !== "partial") return null;
  const today = isoDay(now.getTime());
  let best: CostFxReading | null = null;
  for (const row of Array.isArray(response.data) ? response.data : []) {
    const at = typeof row?.date === "string" ? Date.parse(row.date) : Number.NaN;
    if (!Number.isFinite(at) || !Number.isFinite(row.close) || row.close <= 0) continue;
    const rowDay = isoDay(at);
    if (rowDay > date || rowDay >= today || Date.parse(`${rowDay}T00:00:00Z`) < day - LOOKBACK_DAYS * DAY_MS) continue;
    if (!best || rowDay > best.date) best = { rate: leg.invert ? 1 / row.close : row.close, date: rowDay };
  }
  return best;
}

/**
 * What one unit of `from` (a lot's currency, GBp counting pence) cost in
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
  const fromUnit = resolveCurrencyUnit(from);
  const intoUnit = resolveCurrencyUnit(into);
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
