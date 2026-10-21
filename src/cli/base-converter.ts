import type { DataProvider } from "../types/data-provider";
import { fixedUsdRate, heldCurrencyUnit } from "../utils/currency-units";
import { logFailure } from "../utils/log-failure";

/** One rate a converter used: units of `baseCurrency` per unit of `currency`, and when it was observed. */
export interface BaseConversion {
  currency: string;
  baseCurrency: string;
  rate: number;
  /** Epoch ms of the older leg's observation; null when the source did not date it. */
  asOf: number | null;
}

/** Converts an amount into the base currency, and lists the rates it used so a report can state them. */
export type BaseConverter = ((value: number, fromCurrency: string) => Promise<number>) & {
  conversions(): BaseConversion[];
};

interface UsdRate {
  rate: number;
  asOf: number | null;
}

export function createBaseConverter(
  dataProvider: Pick<DataProvider, "getExchangeRate" | "getCachedQuery" | "revalidatesInBackground">,
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
        return { rate: Number.isFinite(entry.value) && entry.value > 0 ? entry.value : Number.NaN, asOf: entry.asOf ?? null };
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
    });
    return (value / from.divisor * fromRate.rate) / baseRate.rate * base.divisor;
  };

  return Object.assign(convert, { conversions: () => [...used.values()] });
}
