import { apiClient } from "../../../api-client";
import type { DividendSummary } from "../../../api-client/market-discovery";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { DividendMetrics, DividendPayment, GrowthPayments } from "./types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { calendarMonthsBefore } from "../../../utils/calendar-date";
import { cashDistribution, combinedPaymentTimes, dividendReferencePrice, dividendYieldAt, inferCadence, statedCadence, trailingCashAt, trailingDividendRate, trailingPayments as countedTrailingPayments, trailingPaymentShortfall, trailingSpecialCash, unevenRegularPayments, type DistributionCadence } from "../../../utils/trailing-dividend";
import { dividendQuotePriceMetadata } from "./reference-price";
import { mapQuote } from "../../../sources/gloomberb-cloud/normalizers";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { declaredDividends, dividendNoticeSource } from "../../../utils/declared-dividends";
import { atSourcePrecision, cashInMajorUnits } from "../../../utils/dividend-cash";
import { lapsedDividend, monthlyHistoryEnd } from "../../../utils/forward-dividend";
import type { DeclaredCash, DeclaredDividendAction, TickerFinancials } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";
import { isCryptoInstrumentType } from "../../../tickers/search/ranking";
import { isCryptoPairSymbol } from "../../../utils/crypto-pair";

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
function unavailableDividendSummary(triedAt?: string, { forward = false, payDate = false } = {}): string {
  return `Dividend summary unavailable${lastTried(triedAt)}; no ${forward ? "payout ratio" : "forward rate, payout ratio"}${payDate ? "" : " or pay date"}.`;
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
  pending.catch(() => {
    // Intentional ignore: fetchDividendData awaits this same promise and reports its failure.
  });
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
 * The dividends a history row holds by its issuer's own announcement forms
 * (Gloom Cloud's `parts` of an HKEX row): each with its amount, whether it is
 * a special and the form's type, summing to the row. Null for a row without
 * them, or with parts that are no cash or do not sum to it.
 */
function formParts(value: unknown, amount: number): { amount: number; special: boolean; type: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts = value.flatMap((part) => {
    const { amount: cash, special, type } = (part ?? {}) as { amount?: unknown; special?: unknown; type?: unknown };
    return typeof cash === "number" && Number.isFinite(cash) && cash > 0 && typeof special === "boolean"
      ? [{ amount: cash, special, type: typeof type === "string" ? type : "" }] : [];
  });
  const sum = parts.reduce((total, part) => total + part.amount, 0);
  return parts.length === value.length && Math.abs(sum - amount) <= 1e-6 * Math.max(1, amount) ? parts : null;
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
  /** Beside convertedFrom, the sub-unit the source states the cash in (GBp, ZAc): converted amounts are written in it. */
  convertedSubUnit?: string;
  /** Declared and unpaid, in `currency`; issuer-confirmed ex-dated rows also enter `payments`. Absent from older servers. */
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
  declaredCashAsOf?: string;
  cashVerificationWarning?: string;
  stale?: boolean;
  priceAsOf?: string;
  priceStale?: boolean;
  /** The quote's providerPriceDivisor (100 for a line quoted in pence), so the price keeps the decimals it trades in. */
  priceQuotedUnitDivisor?: number;
  /**
   * A crypto token: it pays no distributions, and a yield it earns (USDY's) accrues in its price, so it has no cash
   * yield to show, never 0.00% (TOKEN_YIELD_NOTE).
   */
  token?: true;
}

/** Why a token's yields are blank: said beside them, short. */
export const TOKEN_YIELD_NOTE = "token: no payouts, any yield accrues in its price";

/** A coin or token: a crypto instrument by its quote's type, else a coin pair (USDY-USD) on the crypto venue or none. */
function isToken(symbol: string, exchange: string, instrumentType: string | undefined): boolean {
  if (instrumentType) return isCryptoInstrumentType(instrumentType);
  return isCryptoPairSymbol(symbol.trim().toUpperCase()) && (!exchange || exchange.toUpperCase() === "CCC");
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
  const summaryUnit = resolveCurrencyUnit(quoteFields?.currency);
  const currency = cashCurrency || summaryUnit.currency;
  let historyError = !actions && response.data.historyError ? unavailableDividendHistory(triedAt) : response.data.historyError;
  if (actions && !cashCurrency) historyError = MISSING_DIVIDEND_CURRENCY;
  if (!currency && (quoteFields?.trailingAnnualDividendRate != null || quoteFields?.forwardAnnualDividendRate != null)) {
    historyError = MISSING_DIVIDEND_CURRENCY;
  }
  const declaredCash = cashCurrency ? declaredCashByExDate(actions?.declaredCash, cashCurrency) : new Map();
  const convertedFrom = cashCurrency ? declaredCurrencyOf(actions?.declaredCash, cashCurrency) : undefined;
  const sourceUnit = sourceActions?.currency;
  const convertedSubUnit = convertedFrom && sourceUnit && resolveCurrencyUnit(sourceUnit).divisor !== 1 ? sourceUnit : undefined;
  const declared = actions && cashCurrency ? declaredDividends(actions) : [];
  const distributions = actions ? [...actions.dividends, ...declared.filter((row) => declaredCash.has(row.exDate) && Date.parse(row.exDate) <= Date.now())] : [];
  // A row its issuer's forms split is one payment per dividend they state, a special typed as one.
  const partsOf = (action: (typeof distributions)[number]) => "parts" in action ? formParts(action.parts, action.amount) : null;
  const listed = cashCurrency ? distributions.flatMap(action => {
    const payment = toDividendPayment(action.exDate, action.amount, cashCurrency);
    const declared = declaredCash.get(action.exDate);
    const source = dividendNoticeSource(action.source);
    const row = payment ? { ...payment, paymentDate: action.payDate ? reportedDividendDate(Date.parse(action.payDate) / 1000) : null,
      recordDate: action.recordDate ? reportedDividendDate(Date.parse(action.recordDate) / 1000) : null,
      ...(declared ? { declared } : {}), ...("cashEstimate" in action && action.cashEstimate ? { cashEstimate: action.cashEstimate } : {}),
      ...(source ? { source } : {}) } : null;
    const parts = row && partsOf(action);
    if (row && parts) return parts.map((part) => ({ ...row, amount: part.amount, type: part.special ? "special" as const : "cash" as const,
      ...(part.special ? { special: true as const } : {}), formTyped: true as const, ...(part.type ? { formType: part.type } : {}),
      ...(declared && row.amount > 0 ? { declared: { ...declared, amount: declared.amount * part.amount / row.amount } } : {}) }));
    return row ? [row] : [];
  }).sort((a, b) => b.exDate.getTime() - a.exDate.getTime()) : [];
  // A regular payment and an extra one on one ex-date are one row of the history: the row says it is both.
  const combined = combinedPaymentTimes(listed);
  const merged = combined.size ? listed.map((payment) => combined.has(payment.exDate.getTime()) ? { ...payment, combined: true as const } : payment) : listed;
  // A declared row is the issuer's (or the server's) own: it says itself whether its conversion is fixed.
  const payments = convertedFrom ? withUnfixedConversions(merged, quoteFields, cashCurrency, new Set(declared.map((row) => row.exDate))) : merged;
  const rows = distributions.reduce((count, action) => count + (partsOf(action)?.length ?? 1), 0);
  if (!historyError && actions && (actions.coverage?.dividends === "unavailable" || payments.length !== rows)) {
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
  const announced = actions?.declaredCash?.announced;
  const announcedFields = announced ? { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null,
    forwardAnnualDividendRate: null, payoutRatio: null, currency: currency || null, ...quoteFields,
    exDividendDate: Date.parse(announced.exDate) / 1000, dividendDate: Date.parse(announced.payDate) / 1000,
  } : quoteFields;
  const metricFields = actions && historyError && announcedFields ? { ...announcedFields, trailingAnnualDividendRate: null } : announcedFields;
  const token = isToken(symbol, exchange, quote?.instrumentType);
  const built = buildDividendMetrics(payments, metricFields, price, { historyAvailable, summaryRatesComparable, declared });
  // A token's empty history is no 0.00% yield: it has none to measure.
  let metrics = token && payments.length === 0
    ? { ...built, trailingRate: null, forwardRate: null, trailingYield: null, forwardYield: null, forwardRateAsOf: null }
    : built;
  const annualCount = { monthly: 12, quarterly: 4, "semi-annual": 2, annual: 1, irregular: 0 }[metrics.paymentFrequency ?? "irregular"];
  const announcedCash = declared.find((row) => row.exDate === announced?.exDate);
  const announcedAmount = announced?.paidAmount ?? announcedCash?.amount;
  const announcedUneven = announcedCash && historyAvailable && !metrics.lapse
    ? unevenRegularPayments(payments, new Date(), announcedAmount != null && annualCount > 0
      ? { exDate: new Date(`${announced!.exDate}T00:00:00Z`), annualRate: announcedAmount * annualCount } : null)
    : null;
  if (announcedUneven) {
    metrics = repriceDividendMetrics({ ...metrics, forwardRate: announcedUneven.total, forwardBasis: "uneven",
      forwardRateAsOf: announcedUneven.latest.toISOString().slice(0, 10) }, price);
  } else if (announced && announcedAmount != null && !metrics.lapse && metrics.forwardBasis !== "uneven" && annualCount > 0) {
    metrics = repriceDividendMetrics({ ...metrics, forwardRate: announcedAmount * annualCount, forwardRateAsOf: announced.exDate }, price);
  } else if (!metrics.lapse && metrics.forwardRate != null && metrics.forwardBasis !== "uneven" && annualCount > 0) {
    // A stated rate dated by a declared regular distribution is that amount at the payer's cadence, as its basis
    // says: OXLC's declared $0.20 monthly is $2.40 a year, where the stated rate read $1.20.
    const row = declared.find((entry) => entry.exDate === metrics.forwardRateAsOf && !entry.special && !entry.cashEstimate);
    if (row && Number.isFinite(row.amount) && row.amount > 0) {
      metrics = repriceDividendMetrics({ ...metrics, forwardRate: atSourcePrecision(row.amount * annualCount) }, price);
    }
  }
  const summaryError = !summary
    ? unavailableDividendSummary(triedAt, { forward: quoteFields != null || metrics.forwardRate != null, payDate: metrics.nextPayDate != null })
    : response.data.summaryError ?? ([summary.exDividendDate, summary.dividendDate]
      .some((timestamp) => timestamp != null && reportedDividendDate(timestamp) === null)
      ? INVALID_DIVIDEND_SUMMARY_DATE : undefined);
  if (metrics.forwardRate != null && metrics.forwardBasis === "uneven" && metrics.trailingEstimates?.length) {
    metrics.forwardEstimate = metrics.trailingEstimates.at(-1);
  } else if (metrics.forwardRate != null && metrics.forwardBasis !== "uneven" && convertedFrom && (!announced || announced.paidAmount == null || !annualCount)) {
    // Without an announcement the rate annualizes the latest distribution: one still unfixed is its estimate too.
    metrics.forwardEstimate = announcedCash?.cashEstimate ?? (!announced ? metrics.trailingEstimates?.at(-1) : undefined) ?? { declaredCurrency: convertedFrom,
      ...(announced ? { declaredAmount: announced.amount, fixingDate: announced.fixingDate } : {}),
      basis: announced ? "Indicated annual rate converted from the declared currency; the issuer's cash-currency conversion is not fixed."
        : "Indicated annual rate converted from the declared currency; the conversion rate and fixing date are unavailable.",
    };
  }
  if (!historyAvailable && !historyError && metrics.trailingRate == null && metrics.forwardRate == null && !token) {
    throw new Error(`No dividend data found for ${symbol}`);
  }
  return {
    ...(token && payments.length === 0 ? { token: true as const } : {}),
    payments, ...(declared.length > 0 ? { declared } : {}), ...(convertedFrom ? { convertedFrom } : {}), ...(convertedSubUnit ? { convertedSubUnit } : {}), metrics, price, currency: currency || undefined, historyAvailable,
    ...(suppliedPrice == null && price != null && quote ? dividendQuotePriceMetadata(quote) : {}),
    ...(historyError ? { historyError } : {}), ...(summaryError ? { summaryError } : {}),
    ...(statedFields && metrics.forwardRate != null ? { forwardFromFundamentals: true } : {}),
    // A history standing in for a refresh that could not read it is dated by its own read.
    providerId: actions?.providerId ?? "gloom", fetchedAt: [actions?.dividendsAsOf ?? actions?.fetchedAt, actions?.declaredCash?.fetchedAt]
      .filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort()[0],
    declaredCashAsOf: actions?.declaredCash?.fetchedAt,
    ...(actions?.declaredCash?.verification === "unavailable" ? { cashVerificationWarning: "Dividend cash is not issuer-verified; issuer confirmation is unavailable. Upstream history is shown." } : {}),
    stale: response.stale === true || response.data.stale === true || actions?.stale === true || actions?.declaredCash?.stale === true,
    notes: ["Cash yield excludes taxes and reinvestment. Unannounced future payments and tax components are not modeled."],
  };
}

const DAY_MS = 86_400_000;
/** Ex-dates this close are one distribution on two listings (SHEL:LSE ex 12 Nov, SHEL:NYSE ex 13 Nov), as the server pairs them. */
const SAME_DISTRIBUTION_DAYS = 4;

/**
 * History payments in a currency the company does not declare in that are
 * not paid yet, marked as estimates as an issuer's unfixed conversion is (HSBA's):
 * the amount is the source's conversion at a market rate until the issuer
 * fixes its own, near the pay date. Shell's 29.858244p for its 12 Nov
 * $0.3906, paid 21 Dec, is one. A payment is unpaid by its own pay date, or
 * by the summary's for the distribution its ex-date names; one with neither
 * is left as it is.
 */
function withUnfixedConversions(payments: DividendPayment[], summary: QuoteSummaryDividendFields | null, cashCurrency: string,
  declaredExDates: ReadonlySet<string>, now = new Date()): DividendPayment[] {
  const today = now.toISOString().slice(0, 10);
  const statedEx = reportedDividendDate(summary?.exDividendDate ?? null);
  const statedPay = reportedDividendDate(summary?.dividendDate ?? null);
  return payments.map((payment) => {
    if (!payment.declared || payment.cashEstimate || payment.exDate > now || declaredExDates.has(payment.exDate.toISOString().slice(0, 10))) return payment;
    const payDate = payment.paymentDate
      ?? (statedEx && statedPay && Math.abs(statedEx.getTime() - payment.exDate.getTime()) <= SAME_DISTRIBUTION_DAYS * DAY_MS ? statedPay : null);
    if (!payDate || payDate.toISOString().slice(0, 10) <= today) return payment;
    return { ...payment, cashEstimate: { declaredCurrency: payment.declared.currency, declaredAmount: payment.declared.amount,
      basis: `Reported cash estimate; the issuer's ${cashCurrency} conversion is not fixed.` } };
  });
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
  const declared = options.declared ?? [];
  const eligible = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0);
  // The trailing rate every trailing yield reads (trailingDividendRate), fundamentals' for a fund included.
  const trailingRate = options.historyAvailable !== false
    ? trailingDividendRate(payments, now)
    : options.summaryRatesComparable !== false ? quoteFields?.trailingAnnualDividendRate ?? null : null;
  const trailingEstimates = options.historyAvailable !== false
    ? countedTrailingPayments(payments, now).counted.flatMap((payment) => payment.cashEstimate ? [payment.cashEstimate] : []) : [];
  // The specials the issuer's forms type in the year, which the trailing rate counts and the forward one never does.
  const trailingSpecial = options.historyAvailable !== false ? atSourcePrecision(trailingSpecialCash(payments, now)) : 0;
  const statedRate = options.summaryRatesComparable !== false ? quoteFields?.forwardAnnualDividendRate ?? null : null;
  const statedAsOf = statedRate != null && /^\d{4}-\d{2}-\d{2}$/.test(quoteFields?.forwardRateAsOf ?? "")
    ? quoteFields!.forwardRateAsOf! : null;
  // A reported ex-date can be the latest one or an announced one; keep them apart.
  const reportedExDate = reportedDividendDate(quoteFields?.exDividendDate ?? null);
  const pastExDates = payments.filter((payment) => payment.exDate <= now).map((payment) => payment.exDate.getTime());
  if (reportedExDate && reportedExDate <= now) pastExDates.push(reportedExDate.getTime());
  const latestExDate = pastExDates.length > 0 ? new Date(Math.max(...pastExDates)) : null;
  const upcomingExDates = payments.filter((payment) => payment.exDate > now).map((payment) => payment.exDate.getTime());
  const declaredExDates = declared.map((row) => Date.parse(row.exDate)).filter((time) => time > now.getTime());
  upcomingExDates.push(...declaredExDates);
  if (reportedExDate && reportedExDate > now) upcomingExDates.push(reportedExDate.getTime());
  const nextExDividendDate = upcomingExDates.length > 0 ? new Date(Math.min(...upcomingExDates)) : null;

  const reportedPayDate = reportedDividendDate(quoteFields?.dividendDate ?? null);
  const today = new Date(now.toISOString().slice(0, 10));
  const paymentDates = payments.flatMap((payment) => payment.paymentDate && payment.paymentDate >= today ? [payment.paymentDate] : []);
  for (const row of declared) {
    const date = new Date(row.payDate ?? "");
    if (date >= today) paymentDates.push(date);
  }
  if (reportedPayDate && reportedPayDate >= today) paymentDates.push(reportedPayDate);
  const nextPayDate = paymentDates.length ? new Date(Math.min(...paymentDates.map((date) => date.getTime()))) : null;
  // A date the summary carries from the company's other listing names it, where it is the one shown.
  const carriedFrom = (shown: Date | null, reported: Date | null, listing: string | undefined) =>
    listing && shown && reported && shown.getTime() === reported.getTime() ? listing : undefined;
  const nextExDividendDateListing = carriedFrom(nextExDividendDate, reportedExDate, quoteFields?.exDividendDateListing);
  const nextPayDateListing = carriedFrom(nextPayDate, reportedPayDate, quoteFields?.dividendDateListing);

  // A dividend that has stopped has no forward rate, whatever is still stated for it.
  // Without a usable history only the latest date known says it, on the annual window.
  // A monthly payer's history that stops short says so, and its forward rate, trailing yield and last ex-date stop with it:
  // a rate stated for a distribution the history does not hold (IEF's as of 2026-11-02 beside its 2026-09-01) is not shown.
  const historyEnd = options.historyAvailable !== false
    ? monthlyHistoryEnd({ exDates: eligible.map((payment) => payment.exDate), declared: [
      ...declared, ...payments.filter((payment) => payment.exDate > now).map((payment) => ({ exDate: payment.exDate.toISOString().slice(0, 10) })),
    ] }, now)
    : null;
  const lastExDividendDate = historyEnd ? new Date(historyEnd) : latestExDate;
  const lapse = historyEnd ? { lastPaid: historyEnd, historyEnds: true as const } : options.historyAvailable !== false
    ? lapsedDividend(statedAsOf, {
      exDates: [...payments.map((payment) => payment.exDate), ...latestExDate ? [latestExDate] : []], declared }, now)
    : lapsedDividend([statedAsOf, latestExDate?.toISOString().slice(0, 10)]
      .filter((day): day is string => !!day).sort().at(-1), { exDates: null, declared }, now);
  // A year whose regular payments differ widely (HSBC's final beside its interims) has no one payment to annualize: its total stands.
  // A cut or a raise that held (ECC's $0.14 monthly, then $0.06) is the new rate, which the stated one annualizes.
  const uneven = statedRate != null && !lapse && options.historyAvailable !== false
    ? unevenRegularPayments(eligible, now, statedAsOf ? { exDate: new Date(`${statedAsOf}T00:00:00Z`), annualRate: statedRate } : null) : null;
  const forwardRate = lapse ? null : uneven ? uneven.total : statedRate;
  const forwardRateAsOf = lapse ? null : uneven ? uneven.latest.toISOString().slice(0, 10) : statedAsOf;
  const growth1Y = options.historyAvailable !== false ? computeGrowth(eligible, 1, now) : null;
  const growth3Y = options.historyAvailable !== false ? computeGrowth(eligible, 3, now) : null;

  // A payout over zero or negative earnings (ECC's 2000% beside an EPS of -1.30) is not a payout, whatever the source states.
  const payoutNotMeaningful = typeof quoteFields?.trailingEps === "number" && Number.isFinite(quoteFields.trailingEps) && quoteFields.trailingEps <= 0;
  // A young history's two ex-dates show one gap: the stated rate says its cadence where it reads one (statedCadence).
  const stated = options.historyAvailable !== false && statedRate != null
    ? statedCadence(eligible, now, { annualRate: statedRate, exDate: statedAsOf ? new Date(`${statedAsOf}T00:00:00Z`) : null }) : null;
  // A trailing yield over a hole in a regular payer's history says how many payments it counts; a stopped dividend has said so.
  const trailingPayments = options.historyAvailable !== false && !lapse ? trailingPaymentShortfall(eligible, now, stated) : null;

  return repriceDividendMetrics({
    trailingYield: null,
    forwardYield: null,
    trailingRate,
    ...(trailingEstimates.length ? { trailingEstimates } : {}),
    ...(trailingSpecial > 0 ? { trailingSpecial } : {}),
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
    ...(growth1Y?.notMeaningful ? { growth1YNotMeaningful: true } : {}),
    ...(growth3Y?.notMeaningful ? { growth3YNotMeaningful: true } : {}),
    paymentFrequency: options.historyAvailable !== false ? inferFrequency(eligible, now, stated) : null,
    lastExDividendDate,
    nextExDividendDate,
    nextPayDate,
    ...nextExDividendDateListing ? { nextExDividendDateListing } : {},
    ...nextPayDateListing ? { nextPayDateListing } : {},
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
 * suspension, which still reads as a full decline. Cash paid after a year of
 * none is growth off zero: not meaningful, never a number.
 */
function computeGrowth(payments: DividendPayment[], years: number, now: Date): { growth: number | null; shortfall?: GrowthPayments; notMeaningful?: true } | null {
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
  if (!(prior > 0)) return recent > 0 ? { growth: null, notMeaningful: true } : { growth: null };
  return { growth: Math.pow(recent / prior, 1 / years) - 1 };
}

function inferFrequency(payments: DividendPayment[], now: Date, stated: DistributionCadence | null = null): DividendMetrics["paymentFrequency"] {
  if (!payments.some((payment) => payment.exDate > calendarMonthsBefore(now, 12))) return null;
  return stated ?? inferCadence(payments, now);
}
