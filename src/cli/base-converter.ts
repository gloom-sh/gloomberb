import type { DataProvider } from "../types/data-provider";

export function createBaseConverter(dataProvider: Pick<DataProvider, "getExchangeRate">, baseCurrency: string) {
  const rateCache = new Map<string, number>([["USD", 1]]);

  const getRate = async (currency: string): Promise<number> => {
    const normalizedCurrency = currency.toUpperCase();
    const cached = rateCache.get(normalizedCurrency);
    if (cached != null) return cached;
    try {
      const rate = await dataProvider.getExchangeRate(normalizedCurrency);
      const validRate = Number.isFinite(rate) && rate > 0 ? rate : Number.NaN;
      rateCache.set(normalizedCurrency, validRate);
      return validRate;
    } catch {
      return Number.NaN;
    }
  };

  return async (value: number, fromCurrency: string): Promise<number> => {
    const normalizedFrom = fromCurrency.toUpperCase();
    const normalizedBase = baseCurrency.toUpperCase();
    if (normalizedFrom === normalizedBase) return value;

    const [fromRate, baseRate] = await Promise.all([
      getRate(normalizedFrom),
      getRate(normalizedBase),
    ]);
    if (!Number.isFinite(fromRate) || !Number.isFinite(baseRate) || baseRate <= 0) return Number.NaN;
    return (value * fromRate) / baseRate;
  };
}
