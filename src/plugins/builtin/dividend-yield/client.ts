import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { deriveMarketState, financeRawNumber, mapYahooDividends } from "../../../sources/yahoo-finance/mappers";
import { isTimestampStaleForExchangeSession } from "../../../market-data/market/freshness";
import { fetchYahooChart } from "../../../sources/yahoo-finance/requests";
import { getYahooSymbolsToTry } from "../../../sources/yahoo-finance/symbols";
import type { QuoteSummaryResponse } from "../../../sources/yahoo-finance/types";
import type { DividendMetrics, DividendPayment } from "./types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { calendarYearsBefore } from "./calendar";
import { inferCadence, trailingCashAt } from "./trailing-cash";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { dividendPriceAsOf } from "./reference-price";

export const YAHOO_DIVIDENDS_CONNECTION_ID = "yahoo-dividends";
export const INCOMPLETE_DIVIDEND_HISTORY = "Incomplete cash history; totals unavailable.";
export const MISSING_DIVIDEND_CURRENCY = "Dividend currency is unavailable; cash amounts cannot be compared safely.";
export const UNAVAILABLE_DIVIDEND_SUMMARY = "Dividend summary unavailable.";
export const INVALID_DIVIDEND_SUMMARY_DATE = "Invalid dividend summary date.";
const yahoo = new YahooHttpClient();

let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachDividendYieldHealth(health?: ConnectionHealthRegistry): void {
  connectionHealth = health ?? null;
}

export function resetDividendYieldHealth(): void {
  connectionHealth = null;
}

function trackRequest<T>(operation: string, request: () => Promise<T>): Promise<T> {
  return connectionHealth?.hasSource(YAHOO_DIVIDENDS_CONNECTION_ID)
    ? connectionHealth.track(YAHOO_DIVIDENDS_CONNECTION_ID, operation, request)
    : request();
}

interface QuoteSummaryDividendFields {
  trailingAnnualDividendRate: number | null;
  trailingAnnualDividendYield: number | null;
  forwardAnnualDividendRate: number | null;
  payoutRatio: number | null;
  exDividendDate: number | null;
  dividendDate: number | null;
  currency: string | null;
}

const EMPTY_DIVIDEND_FIELDS: QuoteSummaryDividendFields = {
  trailingAnnualDividendRate: null,
  trailingAnnualDividendYield: null,
  forwardAnnualDividendRate: null,
  payoutRatio: null,
  exDividendDate: null,
  dividendDate: null,
  currency: null,
};

/**
 * Yahoo nests quote modules at quoteSummary.result[0], not the response root.
 */
export function extractDividendFields(payload: unknown): QuoteSummaryDividendFields {
  if (typeof payload !== "object" || payload === null) return { ...EMPTY_DIVIDEND_FIELDS };
  const result = (payload as QuoteSummaryResponse).quoteSummary?.result?.[0];
  if (!result) return { ...EMPTY_DIVIDEND_FIELDS };

  const summaryDetail = result.summaryDetail;
  const financialData = result.financialData;
  const defaultKeyStats = result.defaultKeyStatistics;
  // Stock summaries often leave the payment date only in calendarEvents.
  const calendarEvents = result.calendarEvents;

  return {
    trailingAnnualDividendRate: financeRawNumber(summaryDetail?.trailingAnnualDividendRate) ?? null,
    trailingAnnualDividendYield: financeRawNumber(summaryDetail?.trailingAnnualDividendYield) ?? null,
    forwardAnnualDividendRate: financeRawNumber(summaryDetail?.forwardAnnualDividendRate)
      ?? financeRawNumber(summaryDetail?.dividendRate)
      ?? null,
    payoutRatio: financeRawNumber(financialData?.payoutRatio)
      ?? financeRawNumber(defaultKeyStats?.payoutRatio)
      ?? financeRawNumber(summaryDetail?.payoutRatio)
      ?? null,
    exDividendDate: financeRawNumber(summaryDetail?.exDividendDate) ?? financeRawNumber(calendarEvents?.exDividendDate) ?? null,
    dividendDate: financeRawNumber(calendarEvents?.dividendDate) ?? financeRawNumber(summaryDetail?.dividendDate) ?? null,
    currency: typeof summaryDetail?.currency === "string" ? summaryDetail.currency : null,
  };
}

export function toDividendPayment(
  exDate: string,
  amount: number,
  currency: string,
): DividendPayment | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = resolveCurrencyUnit(currency);
  const parsed = new Date(`${exDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== exDate) return null;
  return {
    exDate: parsed,
    recordDate: null,
    paymentDate: null,
    declarationDate: null,
    amount: amount / unit.divisor,
    currency: unit.currency,
    type: "cash",
  };
}

export interface DividendData {
  payments: DividendPayment[];
  metrics: DividendMetrics;
  price: number | null;
  currency?: string;
  /** False when reported records are missing or invalid, even if some rows remain usable. */
  historyAvailable?: boolean;
  historyError?: string;
  /** Independent summary failures do not invalidate usable cash history. */
  summaryError?: string;
  notes?: string[];
  providerId?: string;
  /** Source fetch time, not the last ex-date or this pane's cache-read time. */
  fetchedAt?: string;
  stale?: boolean;
  priceAsOf?: string;
  priceStale?: boolean;
}

export async function fetchDividendData(
  symbol: string,
  currentPrice: number | null,
  exchange = "",
  currentPriceCurrency?: string,
): Promise<DividendData> {
  const qualified = parsePublicTickerKey(symbol);
  const symbols = qualified.exchange
    ? getYahooSymbolsToTry(symbol, exchange, { exactExchange: true })
    : exchange ? getYahooSymbolsToTry(symbol, exchange) : [symbol];
  if (symbols.length === 0) throw new Error(`Dividend source does not support the selected listing ${symbol}`);
  let lastError: unknown;
  for (const yahooSymbol of symbols) {
    try {
      return await fetchDividendDataForSymbol(yahooSymbol, currentPrice, currentPriceCurrency);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`No dividend data found for ${symbol}`);
}

async function fetchDividendDataForSymbol(
  symbol: string,
  currentPrice: number | null,
  currentPriceCurrency?: string,
): Promise<DividendData> {
  const quoteUrl =
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + "?modules=summaryDetail,financialData,defaultKeyStatistics,calendarEvents";

  const [chartResult, quoteResult] = await Promise.allSettled([
    trackRequest("dividend-history", () =>
      fetchYahooChart(yahoo, symbol, "10y", "1mo"),
    ),
    trackRequest("quote-summary", () =>
      yahoo.fetchJsonWithCrumb<QuoteSummaryResponse>(quoteUrl),
    ),
  ]);

  const summaryFailed = quoteResult.status === "rejected" || !!quoteResult.value?.quoteSummary?.error;
  const quoteFields = quoteResult.status === "fulfilled" && !summaryFailed
    ? extractDividendFields(quoteResult.value)
    : null;
  const summaryError = summaryFailed ? UNAVAILABLE_DIVIDEND_SUMMARY
    : quoteFields && [quoteFields.exDividendDate, quoteFields.dividendDate]
      .some((timestamp) => timestamp != null && reportedDividendDate(timestamp) === null)
      ? INVALID_DIVIDEND_SUMMARY_DATE : undefined;

  // Cash events and chart prices need their own denomination. A summary's
  // currency cannot establish the units of a chart that omitted them.
  const chart = chartResult.status === "fulfilled" ? chartResult.value : null;
  const chartUnit = resolveCurrencyUnit(chart?.meta.currency);
  const summaryUnit = resolveCurrencyUnit(quoteFields?.currency);
  const currency = chartUnit.currency || summaryUnit.currency;
  let historyError = chart && !chartUnit.currency ? MISSING_DIVIDEND_CURRENCY : undefined;
  if (!currency && (quoteFields?.trailingAnnualDividendRate != null || quoteFields?.forwardAnnualDividendRate != null)) {
    historyError = MISSING_DIVIDEND_CURRENCY;
  }

  const payments: DividendPayment[] = [];
  if (chart && chartUnit.currency) {
    for (const dividend of mapYahooDividends(chart.events, chart.meta)) {
      const payment = toDividendPayment(dividend.exDate, dividend.amount, chart.meta.currency!);
      if (payment) payments.push(payment);
    }
    payments.sort((a, b) => b.exDate.getTime() - a.exDate.getTime());
    if (payments.length !== Object.keys(chart.events?.dividends ?? {}).length) historyError = INCOMPLETE_DIVIDEND_HISTORY;
  }

  const chartPrice = chartUnit.currency ? chart?.meta.regularMarketPrice : null;
  const suppliedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency);
  const resolvedPrice = suppliedPrice
    ?? (chartPrice != null && Number.isFinite(chartPrice) && chartPrice > 0 ? chartPrice / chartUnit.divisor : null);
  const selectedChart = suppliedPrice == null && resolvedPrice != null && chartResult.status === "fulfilled"
    ? chartResult.value.meta : null;
  const priceAsOf = selectedChart ? dividendPriceAsOf((selectedChart.regularMarketTime ?? NaN) * 1000) : undefined;
  const priceStale = selectedChart && priceAsOf
    ? isTimestampStaleForExchangeSession(Date.parse(priceAsOf), selectedChart.exchangeName, Date.now(), deriveMarketState(selectedChart))
    : undefined;

  const historyAvailable = chart !== null && !historyError;
  // Yahoo annual-rate fields can use a different denomination from its pence
  // charts (VOD.L is one example). Cash history has explicit chart units.
  const summaryRatesComparable = chartUnit.divisor === 1
    && !!summaryUnit.currency && summaryUnit.currency === currency && summaryUnit.divisor === 1;
  // A summary's trailing rate must not conceal an incomplete cash series.
  // Its separately reported forward rate remains usable with known units.
  const metricFields = historyError && quoteFields ? { ...quoteFields, trailingAnnualDividendRate: null } : quoteFields;
  const metrics = buildDividendMetrics(payments, metricFields, resolvedPrice, { historyAvailable, summaryRatesComparable });

  if (!historyAvailable && !historyError && metrics.trailingRate == null && metrics.forwardRate == null) {
    throw new Error(`No dividend data found for ${symbol}`);
  }

  return { payments, metrics, price: resolvedPrice, priceAsOf, priceStale, currency: currency || undefined, historyAvailable,
    ...(historyError ? { historyError } : {}),
    ...(summaryError ? { summaryError } : {}),
    providerId: "yahoo", ...(chartResult.status === "fulfilled" ? { fetchedAt: new Date().toISOString() } : {}),
    notes: ["Cash yield excludes taxes and reinvestment. SEC yield, tax components and future payments are not modeled."],
  };
}

/** A quote from another listing/currency cannot price this cash distribution series. */
export function dividendReferencePrice(price: number | null, priceCurrency: string | undefined, cashCurrency: string): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const unit = resolveCurrencyUnit(priceCurrency);
  if (!unit.currency || unit.currency !== resolveCurrencyUnit(cashCurrency).currency) return null;
  return price / unit.divisor;
}

function reportedDividendDate(timestamp: number | null): Date | null {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp * 1000);
  // Summary dates use the same four-digit calendar-year domain as history.
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999
    ? date : null;
}

export function buildDividendMetrics(
  payments: DividendPayment[],
  quoteFields: QuoteSummaryDividendFields | null,
  currentPrice: number | null,
  options: { historyAvailable?: boolean; summaryRatesComparable?: boolean; now?: Date } = {},
): DividendMetrics {
  const now = options.now ?? new Date();
  const eligible = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0);
  const trailingRate = options.historyAvailable !== false
    ? trailingCashAt(eligible, now)
    : options.summaryRatesComparable !== false ? quoteFields?.trailingAnnualDividendRate ?? null : null;
  const forwardRate = options.summaryRatesComparable !== false ? quoteFields?.forwardAnnualDividendRate ?? null : null;
  const growth1Y = options.historyAvailable !== false ? computeGrowth(eligible, 1, now) : null;
  const growth3Y = options.historyAvailable !== false ? computeGrowth(eligible, 3, now) : null;

  // A reported ex-date can be the latest one or an announced one; keep them apart.
  const reportedExDate = reportedDividendDate(quoteFields?.exDividendDate ?? null);
  const pastExDates = payments.filter((payment) => payment.exDate <= now).map((payment) => payment.exDate.getTime());
  if (reportedExDate && reportedExDate <= now) pastExDates.push(reportedExDate.getTime());
  const lastExDividendDate = pastExDates.length > 0 ? new Date(Math.max(...pastExDates)) : null;
  const upcomingExDates = payments.filter((payment) => payment.exDate > now).map((payment) => payment.exDate.getTime());
  if (reportedExDate && reportedExDate > now) upcomingExDates.push(reportedExDate.getTime());
  const nextExDividendDate = upcomingExDates.length > 0 ? new Date(Math.min(...upcomingExDates)) : null;

  const reportedPayDate = reportedDividendDate(quoteFields?.dividendDate ?? null);
  const today = new Date(now.toISOString().slice(0, 10));
  const nextPayDate = reportedPayDate && reportedPayDate >= today ? reportedPayDate : null;

  return repriceDividendMetrics({
    trailingYield: null,
    forwardYield: null,
    trailingRate,
    forwardRate,
    payoutRatio: quoteFields?.payoutRatio ?? null,
    growth1Y,
    growth3Y,
    paymentFrequency: options.historyAvailable !== false ? inferFrequency(eligible, now) : null,
    lastExDividendDate,
    nextExDividendDate,
    nextPayDate,
  }, currentPrice);
}

export function repriceDividendMetrics(metrics: DividendMetrics, price: number | null): DividendMetrics {
  const validPrice = price != null && Number.isFinite(price) && price > 0;
  return {
    ...metrics,
    trailingYield: validPrice && metrics.trailingRate != null ? metrics.trailingRate / price : null,
    forwardYield: validPrice && metrics.forwardRate != null ? metrics.forwardRate / price : null,
  };
}

function computeGrowth(payments: DividendPayment[], years: number, now: Date): number | null {
  const priorEnd = calendarYearsBefore(now, years);
  const priorStart = calendarYearsBefore(priorEnd, 1);
  // A new fund's partial first year is not a full-year growth baseline.
  if (!payments.some((payment) => payment.exDate <= priorStart)) return null;
  const recent = trailingCashAt(payments, now);
  const prior = trailingCashAt(payments, priorEnd);
  return prior > 0 ? Math.pow(recent / prior, 1 / years) - 1 : null;
}

function inferFrequency(payments: DividendPayment[], now: Date): DividendMetrics["paymentFrequency"] {
  if (!payments.some((payment) => payment.exDate > calendarYearsBefore(now, 1))) return null;
  return inferCadence(payments, now);
}
