import type { EarningsCalendarPayload, EarningsCalendarQuery, EarningsHistoryPayload, EarningsReport } from "../../../api-client/earnings";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { DataProvider, EarningsEvent } from "../../../types/data-provider";
import type { AnalystResearchData, CorporateActionsData, FinancialStatement, PricePoint, TickerFinancials } from "../../../types/financials";

/**
 * META the Monday after its 2026-10-21 report and PLTR a week before its
 * 2026-11-02 one, as Gloom Cloud served them on 2026-10-26 (trimmed to what
 * the earnings functions read). The clock stands at that evening, after the
 * close, so every date is the real one.
 */
export const AGREEMENT_NOW = new Date("2026-10-26T22:00:00.000Z");

const quarter = (date: string, eps: number | undefined, filed: string | undefined, totalRevenue: number): FinancialStatement => ({
  date, currency: "USD", totalRevenue, ...(eps !== undefined ? { eps } : {}),
  // The fiscal fourth quarter's EPS is the results release's: the 10-K states only the year, so no filing dates it.
  ...(filed ? { fieldAvailability: { eps: filed, totalRevenue: filed } } : {}),
});
const year = (date: string, eps: number, filed: string, totalRevenue: number): FinancialStatement => ({
  date, currency: "USD", eps, totalRevenue, fieldAvailability: { eps: filed, totalRevenue: filed },
});
const closes = (values: ReadonlyArray<readonly [string, number]>): PricePoint[] => values.map(([date, close]) => ({ date: new Date(`${date}T20:00:00.000Z`), close }));
const quote = (symbol: string, name: string, price: number, previousClose: number, close = "2026-10-26") => ({
  symbol, name, price, previousClose, change: price - previousClose, changePercent: (price / previousClose - 1) * 100, currency: "USD",
  exchangeName: "NASDAQ", listingExchangeName: "NASDAQ", marketState: "CLOSED" as const, lastUpdated: Date.parse(`${close}T20:00:00.000Z`),
});

/** Gloom Cloud's own trailing EPS and P/E (1.13 and 175.96 for PLTR) disagree with the filed quarters (1.17). */
const PLTR_FINANCIALS: TickerFinancials = {
  quote: quote("PLTR", "Palantir Technologies Inc.", 198.84, 196.75),
  fundamentals: { eps: 1.13, trailingPE: 175.96, forwardPE: 83.76, marketCap: 477.79e9, marketCapCurrency: "USD", financialCurrency: "USD",
    sharesOutstanding: 2.4e9, revenue: 6.16e9 },
  financialCurrency: "USD",
  quarterlyStatements: [
    quarter("2025-03-31", 0.08, "2025-05-06", 0.884e9),
    quarter("2025-06-30", 0.13, "2025-08-05", 1.0e9),
    quarter("2025-09-30", 0.18, "2025-11-04", 1.18e9),
    quarter("2025-12-31", 0.24, undefined, 1.41e9),
    quarter("2026-03-31", 0.34, "2026-05-05", 1.63e9),
    quarter("2026-06-30", 0.41, "2026-08-04", 1.94e9),
  ],
  annualStatements: [year("2024-12-31", 0.19, "2025-02-18", 2.87e9), year("2025-12-31", 0.63, "2026-02-17", 4.48e9)],
  priceHistory: closes([["2026-10-19", 180.12], ["2026-10-20", 182.4], ["2026-10-21", 185.6], ["2026-10-22", 196.2], ["2026-10-23", 196.75], ["2026-10-26", 198.84]]),
};

/** Reported its September quarter on 2026-10-21, filed the 10-Q the next day. */
const META_FINANCIALS: TickerFinancials = {
  quote: quote("META", "Meta Platforms, Inc.", 630.56, 642.62),
  fundamentals: { eps: 29.31, trailingPE: 21.51, forwardPE: 18.28, marketCap: 1.61e12, marketCapCurrency: "USD", financialCurrency: "USD",
    sharesOutstanding: 2.55e9, revenue: 241.61e9 },
  financialCurrency: "USD",
  quarterlyStatements: [
    quarter("2025-03-31", 6.43, "2025-05-01", 42.31e9),
    quarter("2025-06-30", 7.14, "2025-07-31", 47.52e9),
    quarter("2025-09-30", 1.05, "2025-10-30", 51.24e9),
    quarter("2025-12-31", 8.88, undefined, 59.89e9),
    quarter("2026-03-31", 10.44, "2026-04-30", 56.31e9),
    quarter("2026-06-30", 6.18, "2026-07-30", 60.8e9),
    quarter("2026-09-30", 3.83, "2026-10-22", 64.6e9),
  ],
  annualStatements: [year("2024-12-31", 23.86, "2025-01-30", 164.5e9), year("2025-12-31", 23.49, "2026-01-29", 200.97e9)],
  priceHistory: closes([["2026-10-19", 655.1], ["2026-10-20", 650.3], ["2026-10-21", 652.8], ["2026-10-22", 607.1], ["2026-10-23", 642.62], ["2026-10-26", 630.56]]),
};

/** Between ACME's 10-K and its next 10-Q: the evening of 2026-03-16. */
export const YEAR_END_NOW = new Date("2026-03-16T22:00:00.000Z");

/** Four quarters of 1.00 beside a filed year of 3.90: the year is the trailing figure until the March quarter is filed. */
const ACME_FINANCIALS: TickerFinancials = {
  quote: quote("ACME", "Acme Corp.", 100, 99, "2026-03-16"),
  fundamentals: { eps: 3.88, trailingPE: 25.77, marketCap: 50e9, marketCapCurrency: "USD", financialCurrency: "USD", sharesOutstanding: 500e6 },
  financialCurrency: "USD",
  quarterlyStatements: [
    quarter("2024-12-31", 0.9, undefined, 9e9),
    quarter("2025-03-31", 1, "2025-05-01", 10e9),
    quarter("2025-06-30", 1, "2025-07-31", 10e9),
    quarter("2025-09-30", 1, "2025-10-30", 10e9),
    quarter("2025-12-31", 1, undefined, 10e9),
  ],
  annualStatements: [year("2024-12-31", 3.5, "2025-02-20", 36e9), year("2025-12-31", 3.9, "2026-02-20", 40e9)],
  priceHistory: closes([["2026-03-10", 97], ["2026-03-11", 98], ["2026-03-12", 98.5], ["2026-03-13", 99], ["2026-03-16", 100]]),
};

type ActionEarnings = CorporateActionsData["earnings"][number];
const announced = (fields: ActionEarnings): ActionEarnings => ({ dateType: "announcement", currency: "USD", time: "After Hours", ...fields });

const ACTIONS: Record<string, CorporateActionsData> = {
  ACME: { symbol: "ACME", currency: "USD", dividends: [], splits: [], earnings: [] },
  META: { symbol: "META", currency: "USD", dividends: [], splits: [], earnings: [
    announced({ date: "2026-10-21", fiscalPeriod: "2026-09", epsEstimate: 6.52, epsActual: 7.4, difference: 0.88, surprisePercent: 13.5,
      epsAnalysts: 6, epsBasis: "adjusted", dateStatus: "reported" }),
    announced({ date: "2026-07-29", fiscalPeriod: "2026-06", epsEstimate: 7.1, epsActual: 6.18, difference: -0.92, surprisePercent: -12.96,
      epsAnalysts: 13, epsBasis: "gaap", dateStatus: "reported" }),
  ] },
  PLTR: { symbol: "PLTR", currency: "USD", dividends: [], splits: [], earnings: [
    announced({ date: "2026-11-02", fiscalPeriod: "2026-09", epsEstimate: 0.41097, epsAnalysts: 24, epsBasis: null, dateStatus: "confirmed" }),
    announced({ date: "2026-08-03", fiscalPeriod: "2026-06", epsEstimate: 0.28, epsActual: 0.31, difference: 0.03, surprisePercent: 10.71,
      epsAnalysts: 10, epsBasis: "adjusted", dateStatus: "reported" }),
    // Gloom Cloud cannot tell this quarter's basis.
    announced({ date: "2025-05-05", fiscalPeriod: "2025-03", epsEstimate: 0.08, epsActual: 0.04, difference: -0.04, surprisePercent: -50,
      epsAnalysts: 8, epsBasis: null, dateStatus: "reported" }),
  ] },
};

const RESEARCH: Record<string, AnalystResearchData> = {
  ACME: { symbol: "ACME", currency: "USD", recommendations: [], ratings: [], revenueEstimates: [], earningsEstimates: [] },
  META: { symbol: "META", currency: "USD", recommendations: [], ratings: [], revenueEstimates: [], earningsEstimates: [
    { date: "2026-12-31", period: "current quarter", analysts: 41, currency: "USD", average: 8.32977, growth: -0.062 },
  ] },
  PLTR: { symbol: "PLTR", currency: "USD", recommendations: [], ratings: [], revenueEstimates: [], earningsEstimates: [
    { date: "2026-09-30", period: "current quarter", analysts: 24, currency: "USD", average: 0.41097, growth: 0.957 },
  ] },
};

/**
 * The per-ticker calendar. META's still names the report gone by, beside the
 * December quarter's consensus (8.34 from 41 analysts) it has rolled to.
 */
const CALENDAR: Record<string, EarningsEvent> = {
  META: { symbol: "META", name: "Meta Platforms, Inc.", earningsDate: new Date("2026-10-21T20:00:00.000Z"), isDateEstimate: false,
    epsEstimate: 8.33709, epsAnalysts: 41, epsActual: null, revenueEstimate: 74978169530, revenueActual: null, surprise: null, timing: "AMC",
    estimateBasis: {
      epsEstimate: { source: "earningsTrend", sourceValue: 8.33709, period: "0q", periodEndDate: "2026-12-31", currency: "USD" },
      epsAnalysts: { source: "earningsTrend", sourceValue: 41, period: "0q", periodEndDate: "2026-12-31" },
    } },
  PLTR: { symbol: "PLTR", name: "Palantir Technologies Inc.", earningsDate: new Date("2026-11-02T00:00:00.000Z"), isDateEstimate: false,
    dateStatus: "confirmed", epsEstimate: 0.41097, epsAnalysts: 24, epsActual: null, revenueEstimate: 2180834970, revenueActual: null,
    surprise: null, timing: "AMC",
    estimateBasis: {
      epsEstimate: { source: "earningsTrend", sourceValue: 0.41097, period: "0q", periodEndDate: "2026-09-30", currency: "USD" },
      epsAnalysts: { source: "earningsTrend", sourceValue: 24, period: "0q", periodEndDate: "2026-09-30" },
    } },
};

const report = (fields: Partial<EarningsReport> & Pick<EarningsReport, "symbol" | "date">): EarningsReport => ({
  name: null, timing: "amc", timingSource: "filing", reportedAt: null, fiscalPeriod: null, marketCap: null, epsEstimate: null, epsActual: null,
  epsAnalysts: null, revenueEstimate: null, revenueAnalysts: null, implied: null, realized: null, ...fields,
});

/** Gloom Cloud's stored reports, the ones the board, `ERN --date` and `ERN <ticker>` read. */
const STORED: EarningsReport[] = [
  report({ symbol: "META", name: "Meta Platforms, Inc.", date: "2026-10-21", fiscalPeriod: "2026-09", marketCap: 1.61e12, epsEstimate: 6.52,
    epsActual: 7.4, epsAnalysts: 6, revenueEstimate: 63.41e9, epsBasis: "adjusted", dateStatus: "reported" }),
  report({ symbol: "META", name: "Meta Platforms, Inc.", date: "2026-07-29", fiscalPeriod: "2026-06", marketCap: 1.75e12, epsEstimate: 7.1,
    epsActual: 6.18, epsAnalysts: 13, epsBasis: "gaap", dateStatus: "reported" }),
  report({ symbol: "PLTR", name: "Palantir Technologies Inc.", date: "2026-11-02", timingSource: "calendar", fiscalPeriod: "2026-09",
    marketCap: 477.79e9, epsEstimate: 0.41097, epsAnalysts: 24, revenueEstimate: 2.18e9, dateStatus: "confirmed" }),
  report({ symbol: "PLTR", name: "Palantir Technologies Inc.", date: "2026-08-03", fiscalPeriod: "2026-06", marketCap: 410e9, epsEstimate: 0.28,
    epsActual: 0.31, epsAnalysts: 10, epsBasis: "adjusted", dateStatus: "reported" }),
  report({ symbol: "PLTR", name: "Palantir Technologies Inc.", date: "2025-05-05", fiscalPeriod: "2025-03", marketCap: 280e9, epsEstimate: 0.08,
    epsActual: 0.04, epsAnalysts: 8, epsBasis: null, dateStatus: "reported" }),
];

/** ERN's sources, answering each query as Gloom Cloud does: the stored reports in its days, for its companies. */
export const agreementEarningsSources = {
  calendar: async (query: EarningsCalendarQuery): Promise<EarningsCalendarPayload> => ({
    asOf: AGREEMENT_NOW.toISOString(), from: query.from, to: query.to,
    reports: STORED.filter((stored) => stored.date >= query.from && stored.date <= query.to
      && (!query.symbols?.length || query.symbols.includes(stored.symbol)))
      .map((stored) => ({ ...stored, averageMove: null, averageReports: 0 })),
  }),
  history: async (symbol: string): Promise<EarningsHistoryPayload> => ({
    asOf: AGREEMENT_NOW.toISOString(), symbol, name: STORED.find((stored) => stored.symbol === symbol)?.name ?? null,
    reports: STORED.filter((stored) => stored.symbol === symbol).map((stored) => ({ ...stored, revenueActual: null })),
  }),
  upcoming: async (symbols: string[]) => symbols.flatMap((symbol) => CALENDAR[symbol] ? [CALENDAR[symbol]!] : []),
};

const FINANCIALS: Record<string, TickerFinancials> = { ACME: ACME_FINANCIALS, META: META_FINANCIALS, PLTR: PLTR_FINANCIALS };
const known = (symbol: string) => {
  const key = symbol.split(":")[0]!.toUpperCase();
  if (!FINANCIALS[key]) throw new Error(`No fixture for ${symbol}`);
  return key;
};

/** The source behind every other function: financials, corporate actions, estimates and the per-ticker calendar. */
export function createAgreementProvider(): DataProvider {
  return createTestDataProvider({
    getTickerFinancials: async (symbol) => structuredClone(FINANCIALS[known(symbol)]!),
    getQuote: async (symbol) => structuredClone(FINANCIALS[known(symbol)]!.quote!),
    getCorporateActions: async (symbol) => structuredClone(ACTIONS[known(symbol)]!),
    getAnalystResearch: async (symbol) => structuredClone(RESEARCH[known(symbol)]!),
    getEarningsCalendar: async (symbols) => agreementEarningsSources.upcoming(symbols.map(known)),
  });
}
