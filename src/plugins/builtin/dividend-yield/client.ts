import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { financeRawNumber, mapYahooDividends } from "../../../sources/yahoo-finance/mappers";
import { fetchYahooChart } from "../../../sources/yahoo-finance/requests";
import { getYahooSymbolsToTry } from "../../../sources/yahoo-finance/symbols";
import type { QuoteSummaryResponse } from "../../../sources/yahoo-finance/types";
import type { DividendMetrics, DividendPayment } from "./types";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import { calendarYearsBefore } from "./calendar";

export const YAHOO_DIVIDENDS_CONNECTION_ID = "yahoo-dividends";
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
    exDividendDate: financeRawNumber(summaryDetail?.exDividendDate) ?? null,
    dividendDate: financeRawNumber(summaryDetail?.dividendDate) ?? null,
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
  if (Number.isNaN(parsed.getTime())) return null;
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
  historyAvailable?: boolean;
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
  const symbols = exchange ? getYahooSymbolsToTry(symbol, exchange) : [symbol];
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
    + "?modules=summaryDetail,financialData,defaultKeyStatistics";

  const [chartResult, quoteResult] = await Promise.allSettled([
    trackRequest("dividend-history", () =>
      fetchYahooChart(yahoo, symbol, "10y", "1mo"),
    ),
    trackRequest("quote-summary", () =>
      yahoo.fetchJsonWithCrumb<QuoteSummaryResponse>(quoteUrl),
    ),
  ]);

  const quoteFields = quoteResult.status === "fulfilled"
    ? extractDividendFields(quoteResult.value)
    : null;

  const rawCurrency = (chartResult.status === "fulfilled" ? chartResult.value.meta.currency ?? null : null)
    ?? quoteFields?.currency ?? "USD";
  const { currency, divisor } = resolveCurrencyUnit(rawCurrency);

  const payments: DividendPayment[] = [];
  if (chartResult.status === "fulfilled") {
    for (const dividend of mapYahooDividends(chartResult.value.events)) {
      const payment = toDividendPayment(dividend.exDate, dividend.amount, rawCurrency);
      if (payment) payments.push(payment);
    }
    payments.sort((a, b) => b.exDate.getTime() - a.exDate.getTime());
  }

  const chartPrice = chartResult.status === "fulfilled" ? chartResult.value.meta.regularMarketPrice : null;
  const resolvedPrice = dividendReferencePrice(currentPrice, currentPriceCurrency, currency)
    ?? (chartPrice != null && Number.isFinite(chartPrice) && chartPrice > 0 ? chartPrice / divisor : null);

  const historyAvailable = chartResult.status === "fulfilled";
  // Yahoo annual-rate fields can use a different denomination from its pence
  // charts (VOD.L is one example). Cash history has explicit chart units.
  const summaryUnit = resolveCurrencyUnit(quoteFields?.currency);
  const summaryRatesComparable = divisor === 1
    && (!quoteFields?.currency || (summaryUnit.currency === currency && summaryUnit.divisor === 1));
  const metrics = buildDividendMetrics(payments, quoteFields, resolvedPrice, { historyAvailable, summaryRatesComparable });

  if (!historyAvailable && metrics.trailingRate == null && metrics.forwardRate == null) {
    throw new Error(`No dividend data found for ${symbol}`);
  }

  return { payments, metrics, price: resolvedPrice, currency, historyAvailable,
    providerId: "yahoo", ...(historyAvailable ? { fetchedAt: new Date().toISOString() } : {}),
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

export function buildDividendMetrics(
  payments: DividendPayment[],
  quoteFields: QuoteSummaryDividendFields | null,
  currentPrice: number | null,
  options: { historyAvailable?: boolean; summaryRatesComparable?: boolean; now?: Date } = {},
): DividendMetrics {
  const now = options.now ?? new Date();
  const eligible = payments.filter((payment) => payment.exDate <= now && Number.isFinite(payment.amount) && payment.amount > 0);
  const cutoff = calendarYearsBefore(now, 1);
  const trailingRate = options.historyAvailable !== false
    ? eligible.filter((payment) => payment.exDate > cutoff).reduce((sum, payment) => sum + payment.amount, 0)
    : options.summaryRatesComparable !== false ? quoteFields?.trailingAnnualDividendRate ?? null : null;
  const forwardRate = options.summaryRatesComparable !== false ? quoteFields?.forwardAnnualDividendRate ?? null : null;
  const growth1Y = computeGrowth(eligible, 1, now);
  const growth3Y = computeGrowth(eligible, 3, now);

  const exDividendDate = quoteFields?.exDividendDate != null
    ? new Date(quoteFields.exDividendDate * 1000)
    : payments.length > 0
      ? payments[0]!.exDate
      : null;

  const reportedPayDate = quoteFields?.dividendDate != null ? new Date(quoteFields.dividendDate * 1000) : null;
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
    paymentFrequency: inferFrequency(eligible, now),
    exDividendDate,
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

const DAY = 24 * 60 * 60 * 1000;

function computeGrowth(payments: DividendPayment[], years: number, now: Date): number | null {
  const recentStart = calendarYearsBefore(now, 1);
  const priorEnd = calendarYearsBefore(now, years);
  const priorStart = calendarYearsBefore(priorEnd, 1);
  // A new fund's partial first year is not a full-year growth baseline.
  if (!payments.some((payment) => payment.exDate <= priorStart)) return null;
  const recent = payments.filter((p) => p.exDate > recentStart && p.exDate <= now).reduce((sum, p) => sum + p.amount, 0);
  const prior = payments.filter((p) => p.exDate > priorStart && p.exDate <= priorEnd).reduce((sum, p) => sum + p.amount, 0);
  return prior > 0 && recent > 0 ? Math.pow(recent / prior, 1 / years) - 1 : null;
}

function inferFrequency(payments: DividendPayment[], now: Date): DividendMetrics["paymentFrequency"] {
  if (!payments.some((payment) => payment.exDate > calendarYearsBefore(now, 1))) return null;
  const cutoff = calendarYearsBefore(now, 2);
  // Old suspensions or a former schedule must not redefine a fund's recent cadence.
  const dates = [...new Set(payments.filter((payment) => payment.exDate > cutoff).map((payment) => payment.exDate.getTime()))]
    .sort((a, b) => a - b);
  if (dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push((dates[i]! - dates[i - 1]!) / DAY);
  }
  const avgGapDays = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
  if (Math.abs(avgGapDays - 30) < 8) return "monthly";
  if (Math.abs(avgGapDays - 91) < 18) return "quarterly";
  if (Math.abs(avgGapDays - 182) < 36) return "semi-annual";
  if (Math.abs(avgGapDays - 365) < 73) return "annual";
  return "irregular";
}
