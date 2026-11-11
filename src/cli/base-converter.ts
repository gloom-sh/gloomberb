import type { DataProvider } from "../types/data-provider";
import { fixedUsdRate, heldCurrencyUnit } from "../utils/currency-units";
import { logFailure } from "../utils/log-failure";
import { fxQuoteRateMove, readFxQuoteRate } from "./fx-quote-rate";

/** One rate a converter used: units of `baseCurrency` per unit of `currency`, and when it was observed. */
export interface BaseConversion {
  currency: string;
  baseCurrency: string;
  rate: number;
  /** Epoch ms of the older leg's observation; null when the source did not date it. */
  asOf: number | null;
  /** A leg is past its fresh window, or its refresh failed and the last copy stands. */
  stale: boolean;
}

/** Converts an amount into the base currency, and lists the rates it used so a report can state them. */
export type BaseConverter = ((value: number, fromCurrency: string) => Promise<number>) & {
  conversions(): BaseConversion[];
  /** A currency's US dollar rate as the converter reads it, so another conversion on the report uses the same rate; null when unusable. */
  usdRate(currency: string): Promise<UsdRate | null>;
  /**
   * One unit of `currency` (pence as a hundredth of a pound) in the base at the
   * previous daily FX close: the rate the converter uses now, less the pair's
   * move on the day as `fx` reads it. The same rate for a currency priced in
   * the base; null when the pair has no quote or no close.
   */
  previousRate(currency: string): Promise<number | null>;
};

interface UsdRate {
  rate: number;
  asOf: number | null;
  /** Past its fresh window, or kept after a failed refresh. */
  stale?: boolean;
}

export function createBaseConverter(
  dataProvider: Pick<DataProvider, "getExchangeRate" | "getCachedQuery" | "revalidatesInBackground" | "getQuotesBatch">,
  baseCurrency: string,
): BaseConverter {
  const rateCache = new Map<string, Promise<UsdRate>>();
  const used = new Map<string, BaseConversion>();

  /** USD per unit, dated when the cached query says when it was observed (as `fx` dates it). */
  const loadRate = async (currency: string): Promise<UsdRate> => {
    const fixed = fixedUsdRate(currency);
    if (fixed != null) return { rate: fixed, asOf: null };
    try {
      if (dataProvider.getCachedQuery) {
        const entry = await dataProvider.getCachedQuery("getExchangeRate", [currency])
          .load({ background: dataProvider.revalidatesInBackground });
        return {
          rate: Number.isFinite(entry.value) && entry.value > 0 ? entry.value : Number.NaN, asOf: entry.asOf ?? null,
          stale: entry.refreshError != null || entry.staleAt <= Date.now(),
        };
      }
      const rate = await dataProvider.getExchangeRate(currency);
      return { rate: Number.isFinite(rate) && rate > 0 ? rate : Number.NaN, asOf: null };
    } catch (error) {
      logFailure("cli-base-converter", "Could not load base conversion exchange rate")(error);
      return { rate: Number.NaN, asOf: null };
    }
  };

  const getRate = (currency: string): Promise<UsdRate> => {
    const normalizedCurrency = currency.toUpperCase();
    let pending = rateCache.get(normalizedCurrency);
    if (!pending) {
      pending = loadRate(normalizedCurrency);
      rateCache.set(normalizedCurrency, pending);
    }
    return pending;
  };

  // A minor unit converts as its major currency: pence (GBp, GBX) are a hundredth of a pound, and US cents of a dollar.
  const base = heldCurrencyUnit(baseCurrency);
  const convert = async (value: number, fromCurrency: string): Promise<number> => {
    const from = heldCurrencyUnit(fromCurrency);
    if (from.currency === base.currency) return from.divisor === base.divisor ? value : (value / from.divisor) * base.divisor;

    const [fromRate, baseRate] = await Promise.all([getRate(from.currency), getRate(base.currency)]);
    if (!Number.isFinite(fromRate.rate) || !Number.isFinite(baseRate.rate) || baseRate.rate <= 0) return Number.NaN;
    const dates = [fromRate.asOf, baseRate.asOf].filter((time): time is number => time != null);
    // The rate a report states is the major currencies' (GBP/USD), which pence convert at a hundredth of.
    used.set(from.currency, {
      currency: from.currency,
      baseCurrency: base.currency,
      rate: fromRate.rate / baseRate.rate,
      asOf: dates.length > 0 ? Math.min(...dates) : null,
      stale: fromRate.stale === true || baseRate.stale === true,
    });
    return (value / from.divisor * fromRate.rate) / baseRate.rate * base.divisor;
  };

  const usdRate = async (currency: string): Promise<UsdRate | null> => {
    const leg = await getRate(heldCurrencyUnit(currency).currency);
    return Number.isFinite(leg.rate) && leg.rate > 0 ? leg : null;
  };

  const moves = new Map<string, Promise<number | null>>();
  /** The pair's move on the day as a factor (1.001 for +0.1%), as `fx` reads it from the previous daily closes. */
  const dayMove = (currency: string): Promise<number | null> => {
    let pending = moves.get(currency);
    if (!pending) {
      const getQuotesBatch = dataProvider.getQuotesBatch?.bind(dataProvider);
      pending = !getQuotesBatch ? Promise.resolve(null) : readFxQuoteRate(currency, base.currency, getQuotesBatch)
        .then((read) => {
          const move = read && "rate" in read ? fxQuoteRateMove(read) : null;
          return move ? 1 + move.percent / 100 : null;
        })
        .catch(logFailure("cli-base-converter", "Could not read the FX move on the day", null));
      moves.set(currency, pending);
    }
    return pending;
  };

  const previousRate = async (currency: string): Promise<number | null> => {
    const from = heldCurrencyUnit(currency);
    const now = await convert(1, currency);
    if (!Number.isFinite(now)) return null;
    if (from.currency === base.currency) return now;
    const factor = await dayMove(from.currency);
    return factor != null && Number.isFinite(factor) && factor > 0 ? now / factor : null;
  };

  return Object.assign(convert, { conversions: () => [...used.values()], usdRate, previousRate });
}
