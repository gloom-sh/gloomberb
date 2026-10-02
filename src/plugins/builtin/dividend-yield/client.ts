import { apiClient } from "../../../api-client";
import type { DividendSummary } from "../../../api-client/market-discovery";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { DividendMetrics, DividendPayment } from "./types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import { inferCadence, trailingCashAt } from "./trailing-cash";
import { dividendQuotePriceMetadata } from "./reference-price";

export const DIVIDENDS_CONNECTION_ID = "gloom-dividends";
export const INCOMPLETE_DIVIDEND_HISTORY = "Incomplete cash history; totals unavailable.";
export const MISSING_DIVIDEND_CURRENCY = "Dividend currency is unavailable; cash amounts cannot be compared safely.";
export const UNAVAILABLE_DIVIDEND_SUMMARY = "Dividend summary unavailable.";
export const INVALID_DIVIDEND_SUMMARY_DATE = "Invalid dividend summary date.";

let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachDividendYieldHealth(health?: ConnectionHealthRegistry): void {
  connectionHealth = health ?? null;
}

export function resetDividendYieldHealth(): void {
  connectionHealth = null;
}

function trackRequest<T>(operation: string, request: () => Promise<T>): Promise<T> {
  return connectionHealth?.hasSource(DIVIDENDS_CONNECTION_ID)
    ? connectionHealth.track(DIVIDENDS_CONNECTION_ID, operation, request)
    : request();
}

type QuoteSummaryDividendFields = DividendSummary;

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
  const response = await trackRequest("dividends", () => apiClient.getMarketDividends(symbol, exchange));
  if (!response.data) throw new Error(`No dividend data found for ${symbol}`);
  const { actions, quote, summary: quoteFields } = response.data;
  const summaryError = response.data.summaryError ?? (!quoteFields ? UNAVAILABLE_DIVIDEND_SUMMARY
    : [quoteFields.exDividendDate, quoteFields.dividendDate]
      .some((timestamp) => timestamp != null && reportedDividendDate(timestamp) === null)
      ? INVALID_DIVIDEND_SUMMARY_DATE : undefined);
  const cashUnit = resolveCurrencyUnit(actions?.currency);
  const summaryUnit = resolveCurrencyUnit(quoteFields?.currency);
  const currency = cashUnit.currency || summaryUnit.currency;
  let historyError = response.data.historyError;
  if (actions && !cashUnit.currency) historyError = MISSING_DIVIDEND_CURRENCY;
  if (!currency && (quoteFields?.trailingAnnualDividendRate != null || quoteFields?.forwardAnnualDividendRate != null)) {
    historyError = MISSING_DIVIDEND_CURRENCY;
  }
  const payments = actions && cashUnit.currency ? actions.dividends.flatMap(action => {
    const payment = toDividendPayment(action.exDate, action.amount, actions.currency!);
    return payment ? [payment] : [];
  }).sort((a, b) => b.exDate.getTime() - a.exDate.getTime()) : [];
  if (!historyError && actions && (actions.coverage?.dividends === "unavailable" || payments.length !== actions.dividends.length)) {
    historyError = INCOMPLETE_DIVIDEND_HISTORY;
  }
  const suppliedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency);
  const price = suppliedPrice ?? dividendReferencePrice(quote?.price ?? null, quote?.currency, currency);
  const historyAvailable = actions !== null && !historyError;
  // Minor-unit cash histories do not establish the denomination of annual-rate fields.
  const summaryRatesComparable = cashUnit.divisor === 1
    && !!summaryUnit.currency && summaryUnit.currency === currency && summaryUnit.divisor === 1;
  const metricFields = actions && historyError && quoteFields ? { ...quoteFields, trailingAnnualDividendRate: null } : quoteFields;
  const metrics = buildDividendMetrics(payments, metricFields, price, { historyAvailable, summaryRatesComparable });
  if (!historyAvailable && !historyError && metrics.trailingRate == null && metrics.forwardRate == null) {
    throw new Error(`No dividend data found for ${symbol}`);
  }
  return {
    payments, metrics, price, currency: currency || undefined, historyAvailable,
    ...(suppliedPrice == null && price != null && quote ? dividendQuotePriceMetadata({ ...quote, change: quote.change ?? NaN, changePercent: quote.changePercent ?? NaN }) : {}),
    ...(historyError ? { historyError } : {}), ...(summaryError ? { summaryError } : {}),
    providerId: actions?.providerId ?? "gloom", fetchedAt: actions?.fetchedAt,
    stale: response.stale === true || response.data.stale === true || actions?.stale === true,
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
  const priorEnd = calendarMonthsBefore(now, 12 * years);
  const priorStart = calendarMonthsBefore(priorEnd, 12);
  // A new fund's partial first year is not a full-year growth baseline.
  if (!payments.some((payment) => payment.exDate <= priorStart)) return null;
  const recent = trailingCashAt(payments, now);
  const prior = trailingCashAt(payments, priorEnd);
  return prior > 0 ? Math.pow(recent / prior, 1 / years) - 1 : null;
}

function inferFrequency(payments: DividendPayment[], now: Date): DividendMetrics["paymentFrequency"] {
  if (!payments.some((payment) => payment.exDate > calendarMonthsBefore(now, 12))) return null;
  return inferCadence(payments, now);
}
