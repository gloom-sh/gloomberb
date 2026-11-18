import type { HeadlessPaneContext, HeadlessPaneOptionDef } from "../../../types/headless";
import { conversionNote, convertMarketCaps, loadFxLegs, normalizeCapCurrency } from "../research/relative-valuation-currency";

export const STATEMENT_CURRENCY_OPTION: HeadlessPaneOptionDef = {
  key: "currency", type: "string", placeholder: "code", normalize: normalizeCapCurrency,
  description: "Convert reported money at the app's FX rates, naming each rate and time and keeping the native figures.",
  example: "--currency SGD",
};

export async function loadStatementCurrency(target: string, nativeCurrencies: readonly string[], context: Pick<HeadlessPaneContext, "marketData">) {
  const currencies = [...new Set(nativeCurrencies)];
  const { legs } = await loadFxLegs(currencies.some((currency) => currency !== target) ? [target, ...currencies] : [], context);
  const { rows, conversions, unconverted } = convertMarketCaps(currencies.map((currency) => ({
    symbol: currency, marketCap: 1, marketCapCurrency: currency,
  })), target, legs);
  return {
    rates: new Map(rows.filter((row) => row.marketCapCurrency === target).map((row) => [row.symbol, row.marketCap!])),
    conversions,
    note: conversionNote(target, conversions, `Statements in ${target}`),
    rateNotes: conversions.flatMap((conversion) => conversionNote(target, [conversion], `Statements in ${target}`) ?? []),
    failures: unconverted.map(({ currency }) => `No ${currency}/${target} rate; ${currency} figures are not converted.`),
  };
}
