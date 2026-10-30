import { apiClient } from "../../../api-client";
import type { DividendSummary } from "../../../api-client/market-discovery";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { DividendMetrics, DividendPayment, GrowthPayments } from "./types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import { cashDistribution, dividendReferencePrice, dividendYieldAt, inferCadence, trailingCashAt, trailingDividendRate, trailingPaymentShortfall, unevenRegularPayments } from "../../../utils/trailing-dividend";
import { dividendQuotePriceMetadata } from "./reference-price";
import { mapQuote } from "../../../sources/gloomberb-cloud/normalizers";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { declaredDividends } from "../../../utils/declared-dividends";
import { cashInMajorUnits } from "../../../utils/dividend-cash";
import { lapsedDividend } from "../../../utils/forward-dividend";
import type { DeclaredCash, DeclaredDividendAction, TickerFinancials } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";

export const DIVIDENDS_CONNECTION_ID = "gloom-dividends";

/** ` (last tried 2026-10-27 15:38 UTC)`, or nothing when the time is not known. */
function lastTried(at: string | undefined): string {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return "";
  const iso = new Date(time).toISOString();
  return ` (last tried ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC)`;
}

/** A read with some cash rows, but not all of them usable. */
function incompleteDividendHistory(triedAt?: string): string {
  return `Incomplete cash history${lastTried(triedAt)}; totals unavailable.`;
}
/** A read with no cash rows at all: nothing is incomplete, there is nothing. */
function unavailableDividendHistory(triedAt?: string): string {
  return `Cash history unavailable${lastTried(triedAt)}; no payments, totals or growth.`;
}
/** A read without its summary; `forward` when another source still gave the forward rate. */
function unavailableDividendSummary(triedAt?: string, { forward = false } = {}): string {
  return `Dividend summary unavailable${lastTried(triedAt)}; no ${forward ? "payout ratio or pay date" : "forward rate, payout ratio or pay date"}.`;
}
export const INCOMPLETE_DIVIDEND_HISTORY = incompleteDividendHistory();
export const MISSING_DIVIDEND_CURRENCY = "Dividend currency is unavailable; cash amounts cannot be compared safely.";
export const UNAVAILABLE_DIVIDEND_SUMMARY = unavailableDividendSummary();
export const INVALID_DIVIDEND_SUMMARY_DATE = "Invalid dividend summary date.";

/** The forward rate a listing's fundamentals state: the annual rate, in the major unit of `currency`, and the ex-date it annualizes. */
interface StatedForwardRate {
  rate: number;
  exDate: string;
  currency: string;
}

/**
 * The forward rate fundamentals state for a listing (DUK's 4.34, declared,
 * ex 2026-11-13), in its quote's currency; null when its yield is not a
 * forward one or the rate, its ex-date or the currency is missing.
 */
export function statedForwardRate(financials: Pick<TickerFinancials, "fundamentals" | "quote"> | null | undefined): StatedForwardRate | null {
  const fundamentals = financials?.fundamentals;
  const currency = resolveCurrencyUnit(financials?.quote?.currency).currency;
  const rate = fundamentals?.dividendRate;
  const exDate = fundamentals?.exDividendDate;
  if (fundamentals?.dividendYieldBasis !== "forward" || !currency || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0
    || !exDate || !/^\d{4}-\d{2}-\d{2}$/.test(exDate)) return null;
  return { rate, exDate, currency };
}

/** A summary holding only a stated forward rate, dated by its ex-date, for a read whose own summary is missing. */
function statedRateSummary(stated: StatedForwardRate): QuoteSummaryDividendFields {
  return {
    trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null, dividendDate: null,
    forwardAnnualDividendRate: stated.rate, forwardRateAsOf: stated.exDate,
    exDividendDate: Date.parse(`${stated.exDate}T00:00:00Z`) / 1000, currency: stated.currency,
  };
}

interface DividendReadOptions {
  /** The forward rate fundamentals state (statedForwardRate), asked only when the summary is missing. */
  loadStatedForwardRate?: () => Promise<StatedForwardRate | null> | StatedForwardRate | null;
  /** The history already asked for (requestDividendHistory), so it need not wait for the quote the price comes from. */
  history?: Promise<DividendHistoryResponse>;
}

type DividendHistoryResponse = Awaited<ReturnType<typeof apiClient.getMarketDividends>>;

/** Asks Gloom Cloud for a listing's dividend history, for fetchDividendData to read once the price is known. */
export function requestDividendHistory(symbol: string, exchange = ""): Promise<DividendHistoryResponse> {
  const pending = trackRequest("dividends", () => apiClient.getMarketDividends(symbol, exchange));
  // Read by fetchDividendData; a failure there is its error, and none is left unobserved meanwhile.
  pending.catch(() => {});
  return pending;
}

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

/**
 * The declared amount of each paid row by its ex-date: a company declaring in
 * another currency than the listing pays. Rows in the listing's own currency,
 * or with no usable amount, are not a declaration in another currency.
 */
function declaredCashByExDate(declared: DeclaredCash | undefined, cashCurrency: string): Map<string, { amount: number; currency: string }> {
  const unit = resolveCurrencyUnit(declared?.currency);
  if (!declared || !unit.currency || unit.currency === cashCurrency || !Array.isArray(declared.rows)) return new Map();
  return new Map(declared.rows.flatMap((row) => typeof row?.exDate === "string" && Number.isFinite(row.amount) && row.amount > 0
    ? [[row.exDate, { amount: row.amount / unit.divisor, currency: unit.currency }] as const] : []));
}

/**
 * The currency the company declares in when it pays the listing another
 * (South32's dollars, which its rand line converts): the listing's amounts are
 * conversions of it. Undefined for a listing paid in what was declared.
 */
function declaredCurrencyOf(declared: DeclaredCash | undefined, cashCurrency: string): string | undefined {
  const currency = resolveCurrencyUnit(declared?.currency).currency;
  return currency && currency !== cashCurrency ? currency : undefined;
}

export interface DividendData {
  payments: DividendPayment[];
  /** The currency the company declares in, when its amounts here are converted from it (declaredCurrencyOf). */
  convertedFrom?: string;
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
  /** Set when the summary was missing and the forward rate is the one fundamentals state (statedForwardRate). */
  forwardFromFundamentals?: boolean;
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
  options: DividendReadOptions = {},
): Promise<DividendData> {
  const response = await (options.history ?? requestDividendHistory(symbol, exchange));
  if (!response.data) throw new Error(`No dividend data found for ${symbol}`);
  const { actions: sourceActions, quote: rawQuote, summary, triedAt } = response.data;
  // In the major unit as the history arrives, as every other reader of it gets it.
  const actions = sourceActions ? cashInMajorUnits(sourceActions) : null;
  const quote = rawQuote ? mapQuote(rawQuote) : null;
  const cashCurrency = resolveCurrencyUnit(actions?.currency).currency;
  // Without a summary, the forward rate fundamentals state stands in, dated by the ex-date it annualizes (DUK's declared one).
  const stated = !summary && options.loadStatedForwardRate
    ? await Promise.resolve().then(options.loadStatedForwardRate).catch(logFailure("dividend-yield.client", "Read the stated forward rate failed", null))
    : null;
  const statedFields = !summary && stated && (!cashCurrency || stated.currency === cashCurrency) ? statedRateSummary(stated) : null;
  const quoteFields = summary ?? statedFields;
  const summaryError = !summary ? unavailableDividendSummary(triedAt, { forward: quoteFields != null })
    : response.data.summaryError ?? ([summary.exDividendDate, summary.dividendDate]
      .some((timestamp) => timestamp != null && reportedDividendDate(timestamp) === null)
      ? INVALID_DIVIDEND_SUMMARY_DATE : undefined);
  const summaryUnit = resolveCurrencyUnit(quoteFields?.currency);
  const currency = cashCurrency || summaryUnit.currency;
  let historyError = !actions && response.data.historyError ? unavailableDividendHistory(triedAt) : response.data.historyError;
  if (actions && !cashCurrency) historyError = MISSING_DIVIDEND_CURRENCY;
  if (!currency && (quoteFields?.trailingAnnualDividendRate != null || quoteFields?.forwardAnnualDividendRate != null)) {
    historyError = MISSING_DIVIDEND_CURRENCY;
  }
  const declaredCash = cashCurrency ? declaredCashByExDate(actions?.declaredCash, cashCurrency) : new Map();
  const convertedFrom = cashCurrency ? declaredCurrencyOf(actions?.declaredCash, cashCurrency) : undefined;
  const payments = actions && cashCurrency ? actions.dividends.flatMap(action => {
    const payment = toDividendPayment(action.exDate, action.amount, cashCurrency);
    const declared = declaredCash.get(action.exDate);
    return payment ? [declared ? { ...payment, declared } : payment] : [];
  }).sort((a, b) => b.exDate.getTime() - a.exDate.getTime()) : [];
  if (!historyError && actions && (actions.coverage?.dividends === "unavailable" || payments.length !== actions.dividends.length)) {
    // A read with no rows is not an incomplete one.
    historyError = actions.dividends.length === 0 ? unavailableDividendHistory(triedAt) : incompleteDividendHistory(triedAt);
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
    payments, ...(declared.length > 0 ? { declared } : {}), ...(convertedFrom ? { convertedFrom } : {}), metrics, price, currency: currency || undefined, historyAvailable,
    ...(suppliedPrice == null && price != null && quote ? dividendQuotePriceMetadata(quote) : {}),
    ...(historyError ? { historyError } : {}), ...(summaryError ? { summaryError } : {}),
    ...(statedFields && metrics.forwardRate != null ? { forwardFromFundamentals: true } : {}),
    // A history standing in for a refresh that could not read it is dated by its own read.
    providerId: actions?.providerId ?? "gloom", fetchedAt: actions?.dividendsAsOf ?? actions?.fetchedAt,
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
  // A year whose regular payments differ widely (HSBC's final beside its interims) has no one payment to annualize: its total stands.
  const uneven = statedRate != null && !lapse && options.historyAvailable !== false ? unevenRegularPayments(eligible, now) : null;
  const forwardRate = lapse ? null : uneven ? uneven.total : statedRate;
  const forwardRateAsOf = lapse ? null : uneven ? uneven.latest.toISOString().slice(0, 10) : statedAsOf;
  const growth1Y = options.historyAvailable !== false ? computeGrowth(eligible, 1, now) : null;
  const growth3Y = options.historyAvailable !== false ? computeGrowth(eligible, 3, now) : null;

  // A payout over zero or negative earnings (ECC's 2000% beside an EPS of -1.30) is not a payout, whatever the source states.
  const payoutNotMeaningful = typeof quoteFields?.trailingEps === "number" && Number.isFinite(quoteFields.trailingEps) && quoteFields.trailingEps <= 0;
  // A trailing yield over a hole in a regular payer's history says how many payments it counts; a stopped dividend has said so.
  const trailingPayments = options.historyAvailable !== false && !lapse ? trailingPaymentShortfall(eligible, now) : null;

  return repriceDividendMetrics({
    trailingYield: null,
    forwardYield: null,
    trailingRate,
    forwardRate,
    forwardRateAsOf,
    ...(uneven ? { forwardBasis: "uneven" as const } : {}),
    lapse,
    payoutRatio: payoutNotMeaningful ? null : quoteFields?.payoutRatio ?? null,
    payoutNotMeaningful,
    trailingPayments,
    growth1Y: growth1Y?.growth ?? null,
    growth3Y: growth3Y?.growth ?? null,
    ...(growth1Y?.shortfall ? { growth1YPayments: growth1Y.shortfall } : {}),
    ...(growth3Y?.shortfall ? { growth3YPayments: growth3Y.shortfall } : {}),
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

/**
 * Cash growth between the trailing year and the one `years` before it, only
 * when each holds every payment the cadence pays: a year with a hole in its
 * history (AZN's missing August interim) measures the hole, not a cut, so it
 * has no growth and says how many payments it holds. A year with none is a
 * suspension, which still reads as a full decline.
 */
function computeGrowth(payments: DividendPayment[], years: number, now: Date): { growth: number | null; shortfall?: GrowthPayments } | null {
  const priorEnd = calendarMonthsBefore(now, 12 * years);
  const priorStart = calendarMonthsBefore(priorEnd, 12);
  // A new fund's partial first year is not a full-year growth baseline.
  if (!payments.some((payment) => payment.exDate <= priorStart)) return null;
  for (const end of [now, priorEnd]) {
    const short = trailingPaymentShortfall(payments, end);
    if (short && short.counted > 0) {
      return { growth: null, shortfall: { ...short, ...end === now ? {} : { yearTo: end.toISOString().slice(0, 10) } } };
    }
  }
  const recent = trailingCashAt(payments, now);
  const prior = trailingCashAt(payments, priorEnd);
  return { growth: prior > 0 ? Math.pow(recent / prior, 1 / years) - 1 : null };
}

function inferFrequency(payments: DividendPayment[], now: Date): DividendMetrics["paymentFrequency"] {
  if (!payments.some((payment) => payment.exDate > calendarMonthsBefore(now, 12))) return null;
  return inferCadence(payments, now);
}
