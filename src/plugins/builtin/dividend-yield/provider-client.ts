import type { DataProvider } from "../../../types/data-provider";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { buildDividendMetrics, dividendReferencePrice, toDividendPayment, type DividendData } from "./client";
import { dividendQuotePriceMetadata } from "./reference-price";

/** Hosted browsers use their configured provider instead of cross-origin Yahoo requests. */
export async function fetchProviderDividendData(
  provider: Pick<DataProvider, "getCorporateActions" | "getQuote">,
  symbol: string,
  currentPrice: number | null,
  exchange = "",
  currentPriceCurrency?: string,
): Promise<DividendData> {
  if (!provider.getCorporateActions) throw new Error("Dividend history source unavailable.");
  const [actions, quote] = await Promise.all([
    provider.getCorporateActions(symbol, exchange),
    provider.getQuote(symbol, exchange).catch(() => null),
  ]);
  if (actions.coverage?.dividends === "unavailable" || (!actions.coverage?.dividends && actions.dividends.length === 0)) {
    throw new Error("Dividend history is unavailable; this does not mean the security pays no cash.");
  }
  if (!actions.currency) throw new Error("Dividend currency is unavailable; cash amounts cannot be compared safely.");
  const currency = resolveCurrencyUnit(actions.currency).currency;
  const payments = actions.dividends.flatMap((action) => {
    const payment = toDividendPayment(action.exDate, action.amount, actions.currency!);
    return payment ? [payment] : [];
  }).sort((left, right) => right.exDate.getTime() - left.exDate.getTime());
  if (payments.length !== actions.dividends.length) throw new Error("Some dividend records are invalid; a complete cash yield cannot be calculated.");
  const suppliedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency);
  const price = suppliedPrice ?? dividendReferencePrice(quote?.price ?? null, quote?.currency, currency);
  return {
    payments, currency, price, historyAvailable: true,
    providerId: actions.providerId,
    fetchedAt: actions.fetchedAt,
    stale: actions.stale,
    ...(suppliedPrice == null && price != null && quote ? dividendQuotePriceMetadata(quote) : {}),
    metrics: buildDividendMetrics(payments, null, price),
    notes: ["Cash yield excludes taxes and reinvestment. SEC yield, tax components and future payments are not modeled.",
      "This source supplies ex-dates; indicated annual rates and payment dates are unavailable."],
  };
}
