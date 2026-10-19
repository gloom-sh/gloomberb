import { apiClient } from "../../../api-client";
import type { DividendSummary } from "../../../api-client/market-discovery";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { DividendMetrics, DividendPayment } from "./types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import { cashDistribution, dividendReferencePrice, dividendYieldAt, inferCadence, trailingCashAt, trailingDividendRate } from "../../../utils/trailing-dividend";
import { dividendQuotePriceMetadata } from "./reference-price";
import { mapQuote } from "../../../sources/gloomberb-cloud/normalizers";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { declaredDividends } from "../../../utils/declared-dividends";
import { cashInMajorUnits } from "../../../utils/dividend-cash";
import { lapsedDividend } from "../../../utils/forward-dividend";
import type { DeclaredDividendAction } from "../../../types/financials";

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

/** A paid row of a history already in the major unit (cashInMajorUnits); null when its date or amount is not one. */
export function toDividendPayment(
  exDate: string,
  amount: number,
  currency: string,
): DividendPayment | null {
  const paid = cashDistribution(exDate, amount);
  if (!paid) return null;
  return {
    ...paid,
    recordDate: null,
    paymentDate: null,
    declarationDate: null,
    currency,
    type: "cash",
  };
}

export interface DividendData {
  payments: DividendPayment[];
  /** Declared and unpaid, in `currency`; never in `payments` or any figure. Absent from older servers. */
  declared?: DeclaredDividendAction[];
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
  const { actions: sourceActions, quote: rawQuote, summary: quoteFields } = response.data;
  // In the major unit as the history arrives, as every other reader of it gets it.
  const actions = sourceActions ? cashInMajorUnits(sourceActions) : null;
  const quote = rawQuote ? mapQuote(rawQuote) : null;
  const summaryError = response.data.summaryError ?? (!quoteFields ? UNAVAILABLE_DIVIDEND_SUMMARY
    : [quoteFields.exDividendDate, quoteFields.dividendDate]
      .some((timestamp) => timestamp != null && reportedDividendDate(timestamp) === null)
      ? INVALID_DIVIDEND_SUMMARY_DATE : undefined);
  const cashCurrency = resolveCurrencyUnit(actions?.currency).currency;
  const summaryUnit = resolveCurrencyUnit(quoteFields?.currency);
  const currency = cashCurrency || summaryUnit.currency;
  let historyError = response.data.historyError;
  if (actions && !cashCurrency) historyError = MISSING_DIVIDEND_CURRENCY;
  if (!currency && (quoteFields?.trailingAnnualDividendRate != null || quoteFields?.forwardAnnualDividendRate != null)) {
    historyError = MISSING_DIVIDEND_CURRENCY;
  }
  const payments = actions && cashCurrency ? actions.dividends.flatMap(action => {
    const payment = toDividendPayment(action.exDate, action.amount, cashCurrency);
    return payment ? [payment] : [];
  }).sort((a, b) => b.exDate.getTime() - a.exDate.getTime()) : [];
  if (!historyError && actions && (actions.coverage?.dividends === "unavailable" || payments.length !== actions.dividends.length)) {
    historyError = INCOMPLETE_DIVIDEND_HISTORY;
  }
  const suppliedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency);
  // The regular session's price, as the quote headlines it: after the close, the close rather than an after-hours print.
  const price = suppliedPrice ?? dividendReferencePrice(regularSessionValuationPrice(quote), quote?.currency, currency);
  const historyAvailable = actions !== null && !historyError;
  // The annual rates are in the summary's currency, the major unit Gloom Cloud states it in. One stated in a
  // sub-unit, as an older server's is, has them in an unstated unit (SBK's 17.8 "ZAc" is rand), so none is read.
  const summaryRatesComparable = !!summaryUnit.currency && summaryUnit.divisor === 1 && summaryUnit.currency === currency;
  const metricFields = actions && historyError && quoteFields ? { ...quoteFields, trailingAnnualDividendRate: null } : quoteFields;
  const declared = actions && cashCurrency ? declaredDividends(actions) : [];
  const metrics = buildDividendMetrics(payments, metricFields, price, { historyAvailable, summaryRatesComparable, declared });
  if (!historyAvailable && !historyError && metrics.trailingRate == null && metrics.forwardRate == null) {
    throw new Error(`No dividend data found for ${symbol}`);
  }
  return {
    payments, ...(declared.length > 0 ? { declared } : {}), metrics, price, currency: currency || undefined, historyAvailable,
    ...(suppliedPrice == null && price != null && quote ? dividendQuotePriceMetadata(quote) : {}),
    ...(historyError ? { historyError } : {}), ...(summaryError ? { summaryError } : {}),
    providerId: actions?.providerId ?? "gloom", fetchedAt: actions?.fetchedAt,
    stale: response.stale === true || response.data.stale === true || actions?.stale === true,
    notes: ["Cash yield excludes taxes and reinvestment. SEC yield, tax components and future payments are not modeled."],
  };
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
  options: { historyAvailable?: boolean; summaryRatesComparable?: boolean; now?: Date;
    /** Declared, still owed distributions (declaredDividends): one keeps the dividend current. */
    declared?: readonly DeclaredDividendAction[] } = {},
): DividendMetrics {
  const now = options.now ?? new Date();
  const eligible = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0);
  // The trailing rate every trailing yield reads (trailingDividendRate), fundamentals' for a fund included.
  const trailingRate = options.historyAvailable !== false
    ? trailingDividendRate(payments, now)
    : options.summaryRatesComparable !== false ? quoteFields?.trailingAnnualDividendRate ?? null : null;
  const statedRate = options.summaryRatesComparable !== false ? quoteFields?.forwardAnnualDividendRate ?? null : null;
  const statedAsOf = statedRate != null && /^\d{4}-\d{2}-\d{2}$/.test(quoteFields?.forwardRateAsOf ?? "")
    ? quoteFields!.forwardRateAsOf! : null;
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

  // A dividend that has stopped has no forward rate, whatever is still stated for it.
  // Without a usable history only the latest date known says it, on the annual window.
  const declared = options.declared ?? [];
  const lapse = options.historyAvailable !== false
    ? lapsedDividend(statedAsOf, {
      exDates: [...payments.map((payment) => payment.exDate), ...lastExDividendDate ? [lastExDividendDate] : []], declared }, now)
    : lapsedDividend([statedAsOf, lastExDividendDate?.toISOString().slice(0, 10)]
      .filter((day): day is string => !!day).sort().at(-1), { exDates: null, declared }, now);
  const forwardRate = lapse ? null : statedRate;
  const forwardRateAsOf = lapse ? null : statedAsOf;

  return repriceDividendMetrics({
    trailingYield: null,
    forwardYield: null,
    trailingRate,
    forwardRate,
    forwardRateAsOf,
    lapse,
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
  return {
    ...metrics,
    trailingYield: dividendYieldAt(metrics.trailingRate, price),
    forwardYield: dividendYieldAt(metrics.forwardRate, price),
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
