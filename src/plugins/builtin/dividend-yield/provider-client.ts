import type { DataProvider } from "../../../types/data-provider";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { cashInMajorUnits } from "../../../utils/dividend-cash";
import { dividendReferencePrice } from "../../../utils/trailing-dividend";
import { logFailure } from "../../../utils/log-failure";
import { buildDividendMetrics, INCOMPLETE_DIVIDEND_HISTORY, MISSING_DIVIDEND_CURRENCY, toDividendPayment, type DividendData } from "./client";
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
  const [sourceActions, quote] = await Promise.all([
    provider.getCorporateActions(symbol, exchange),
    provider.getQuote(symbol, exchange)
      .catch(logFailure("dividend-yield.provider-client", "Read dividend reference quote failed", null)),
  ]);
  // In the major unit as the history arrives, as the provider router serves it.
  const actions = cashInMajorUnits(sourceActions);
  let historyError = actions.coverage?.dividends !== "available" && actions.dividends.length === 0
    ? "Dividend history is unavailable; this does not mean the security pays no cash." : undefined;
  const currency = resolveCurrencyUnit(actions.currency).currency;
  if (!currency) historyError = MISSING_DIVIDEND_CURRENCY;
  const payments = currency ? actions.dividends.flatMap((action) => {
    const payment = toDividendPayment(action.exDate, action.amount, currency);
    return payment ? [payment] : [];
  }).sort((left, right) => right.exDate.getTime() - left.exDate.getTime()) : [];
  if (!historyError && (actions.coverage?.dividends === "unavailable" || payments.length !== actions.dividends.length)) {
    historyError = INCOMPLETE_DIVIDEND_HISTORY;
  }
  const historyAvailable = !historyError;
  const suppliedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency);
  // The regular session's price, as the quote headlines it: after the close, the close rather than an after-hours print.
  const price = suppliedPrice ?? dividendReferencePrice(regularSessionValuationPrice(quote), quote?.currency, currency);
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
