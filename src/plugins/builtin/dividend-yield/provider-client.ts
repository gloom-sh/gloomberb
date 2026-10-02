import type { DataProvider } from "../../../types/data-provider";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { buildDividendMetrics, dividendReferencePrice, INCOMPLETE_DIVIDEND_HISTORY, MISSING_DIVIDEND_CURRENCY, toDividendPayment, type DividendData } from "./client";
import { dividendQuotePriceMetadata } from "./reference-price";

/** Custom data providers can supply their own cash history and reference quote. */
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
  let historyError = actions.coverage?.dividends !== "available" && actions.dividends.length === 0
    ? "Dividend history is unavailable; this does not mean the security pays no cash." : undefined;
  const currency = resolveCurrencyUnit(actions.currency).currency;
  if (!currency) historyError = MISSING_DIVIDEND_CURRENCY;
  const payments = currency ? actions.dividends.flatMap((action) => {
    const payment = toDividendPayment(action.exDate, action.amount, actions.currency!);
    return payment ? [payment] : [];
  }).sort((left, right) => right.exDate.getTime() - left.exDate.getTime()) : [];
  if (!historyError && (actions.coverage?.dividends === "unavailable" || payments.length !== actions.dividends.length)) {
    historyError = INCOMPLETE_DIVIDEND_HISTORY;
  }
  const historyAvailable = !historyError;
  const suppliedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency);
  const price = suppliedPrice ?? dividendReferencePrice(quote?.price ?? null, quote?.currency, currency);
  return {
    payments, currency: currency || undefined, price, historyAvailable,
    ...(historyError ? { historyError } : {}),
    providerId: actions.providerId,
    fetchedAt: actions.fetchedAt,
    stale: actions.stale,
    ...(suppliedPrice == null && price != null && quote ? dividendQuotePriceMetadata(quote) : {}),
    metrics: buildDividendMetrics(payments, null, price, { historyAvailable }),
    notes: ["Cash yield excludes taxes and reinvestment. SEC yield, tax components and future payments are not modeled.",
      "This source supplies ex-dates; indicated annual rates and payment dates are unavailable."],
  };
}
