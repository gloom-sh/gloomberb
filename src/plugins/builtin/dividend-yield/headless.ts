import type {
  HeadlessBundleResult,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { fetchDividendData, type DividendData } from "./client";
import { dividendReferencePrice } from "../../../utils/trailing-dividend";
import type { DividendPayment } from "./types";
import { formatDividendYield, toDividendRows } from "./view";
import { formatDistributionAmount, formatPercent } from "../../../utils/format";
import { forwardDividendBasis, noCurrentDividend, TRAILING_DIVIDEND_BASIS } from "../../../utils/forward-dividend";
import { currencyPriceMinDigits, formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import type { Quote } from "../../../types/financials";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { dividendPriceStatus, dividendQuotePriceMetadata } from "./reference-price";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { projectDividendRanking, roundedRatio, type DividendRankingEntry } from "./ranking";
import { REPORT_FILTER, REPORT_ROWS } from "../shared/headless-options";

/** Symbols one `fn DVD` ranks at most, and how many it reads at once. */
const MAX_RANKED_SYMBOLS = 25;
const RANKING_CONCURRENCY = 4;
/** The history options' defaults: a ranking lists no history, so only these leave it unchanged. */
const DEFAULT_TYPE = "all";
const DEFAULT_LIMIT = 40;

const PAYMENT_COLUMNS = [
  { key: "exDate", header: "Ex-date" },
  { key: "amount", header: "Amount", align: "right" as const,
    format: (value: unknown, row: Record<string, unknown>) => typeof value === "number" && typeof row.currency === "string" && row.currency
      ? formatDistributionAmount(value, row.currency) : value == null ? "-" : String(value) },
  { key: "currency", header: "CCY" },
  { key: "type", header: "Type" },
];

export interface DividendYieldHeadlessDependencies {
  loadData(symbol: string, context: HeadlessPaneContext): Promise<DividendData>;
}

const defaultDependencies: DividendYieldHeadlessDependencies = {
  async loadData(symbol, context) {
    let currentPrice: number | null = null;
    let currentPriceCurrency: string | undefined;
    let referenceQuote: Quote | undefined;
    const instrument = await context.resolveInstrument?.(symbol);
    const exchange = instrument?.exchange ?? "";
    try {
      const quote = await context.marketData.getQuote(symbol, exchange);
      // The regular session's price: after the close, the close rather than an after-hours print.
      currentPrice = regularSessionValuationPrice(quote);
      currentPriceCurrency = quote.currency;
      referenceQuote = quote;
    } catch {
      currentPrice = null;
    }
    const data = await fetchDividendData(symbol, currentPrice, exchange, currentPriceCurrency);
    if (referenceQuote && dividendReferencePrice(currentPrice, currentPriceCurrency, data.currency ?? "") != null) {
      Object.assign(data, dividendQuotePriceMetadata(referenceQuote));
    }
    return data;
  },
};

function dateEntry(label: string, date: Date | null) {
  return { label, value: date, formatted: date ? date.toISOString().slice(0, 10) : "—" };
}

/** The next pay date, when it is the one stated beside the ex-date the forward rate is dated by. */
function forwardPayDate(metrics: DividendData["metrics"]): Date | null {
  const exDate = metrics.nextExDividendDate?.toISOString().slice(0, 10);
  return exDate != null && exDate === metrics.forwardRateAsOf ? metrics.nextPayDate : null;
}

function matchesType(payment: DividendPayment, type: string): boolean {
  return type === "all" || payment.type === type;
}

export function projectDividendYieldHeadless(
  data: DividendData,
  args: HeadlessPaneLoadArgs,
): HeadlessBundleResult {
  const type = String(args.options.type ?? "all");
  const limit = Number(args.options.limit ?? 40);
  const matching = data.payments.filter((payment) => matchesType(payment, type));
  const selectedPayments = matching.slice(0, limit);
  const rows = toDividendRows(selectedPayments).map((row, index) => {
    const payment = selectedPayments[index];
    return {
      ...row,
      recordDate: payment?.recordDate?.toISOString() ?? null,
      paymentDate: payment?.paymentDate?.toISOString() ?? null,
      declarationDate: payment?.declarationDate?.toISOString() ?? null,
      type: payment?.type ?? null,
    };
  });
  const metrics = data.metrics;
  const currency = data.currency ?? data.payments[0]?.currency ?? "";
  const priceStatus = dividendPriceStatus(data.price, data.priceAsOf, data.priceStale);
  const errors = [data.historyError, data.summaryError].filter((error): error is string => !!error);

  return {
    ...(errors.length > 0 ? { complete: false, errors } : {}),
    sections: [
      {
        title: "Dividend metrics",
        entries: [
          { label: "Price", value: data.price, ...(data.price != null && currency ? { formatted: formatMarketPriceWithCurrency(data.price, currency, { minimumFractionDigits: currencyPriceMinDigits(currency) }) } : {}) },
          ...(data.stale ? [{ label: "History status", value: "Stale cash history; recent distributions may be missing." }] : []),
          ...(priceStatus ? [{ label: "Price status", value: priceStatus === "stale"
            ? "Stale reference price; cash yield may be out of date."
            : "Reference price time unavailable; cash yield may be out of date." }] : []),
          { label: "Trailing yield", value: roundedRatio(metrics.trailingYield), formatted: metrics.trailingYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.trailingYield)} (${TRAILING_DIVIDEND_BASIS})` },
          { label: "Forward yield", value: roundedRatio(metrics.forwardYield), formatted: metrics.lapse ? noCurrentDividend(metrics.lapse)
            : metrics.forwardYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.forwardYield)} (${forwardDividendBasis(metrics.forwardRateAsOf,
              { payDate: forwardPayDate(metrics), declared: data.declared, currency })})` },
          { label: "Trailing rate", value: metrics.trailingRate, formatted: currency ? formatDistributionAmount(metrics.trailingRate ?? undefined, currency) : "—" },
          { label: "Forward rate", value: metrics.forwardRate, formatted: currency ? formatDistributionAmount(metrics.forwardRate ?? undefined, currency) : "—" },
          { label: "Earnings Payout", value: roundedRatio(metrics.payoutRatio), formatted: formatDividendYield(metrics.payoutRatio) },
          { label: "1Y Cash Growth", value: roundedRatio(metrics.growth1Y), formatted: formatPercent(metrics.growth1Y ?? undefined) },
          { label: "3Y Cash CAGR", value: roundedRatio(metrics.growth3Y), formatted: formatPercent(metrics.growth3Y ?? undefined) },
          { label: "Frequency", value: metrics.paymentFrequency },
          dateEntry("Last ex-dividend", metrics.lastExDividendDate),
          dateEntry("Next ex-dividend", metrics.nextExDividendDate),
          dateEntry("Next pay", metrics.nextPayDate),
          ...(data.payments.length > 0 && metrics.trailingRate === 0
            ? [{ label: "Cash status", value: "No cash distributions reported in the past 12 months." }] : []),
        ],
      },
      {
        title: "Dividend history",
        columns: PAYMENT_COLUMNS,
        rows,
        // Each amount is in its own row's currency.
        rowUnitKey: "currency",
      },
    ],
    metadata: {
      totalPayments: matching.length,
      returnedPayments: rows.length,
      truncated: rows.length < matching.length,
      type,
      currency: data.currency ?? data.payments[0]?.currency ?? null,
      historyAvailable: data.historyAvailable ?? true,
      historyError: data.historyError ?? null,
      summaryError: data.summaryError ?? null,
      providerId: data.providerId ?? null,
      historyFetchedAt: data.fetchedAt ?? null,
      historyStale: data.stale ?? null,
      priceAsOf: data.priceAsOf ?? null,
      priceStale: data.priceStale ?? null,
      limitations: data.notes ?? [],
      yieldMethod: "Cash distributions with ex-dates in the preceding 12 months, one payment per period for a regular cadence, divided by the reference share price; excludes reinvestment and is not SEC yield or total return.",
      forwardRateAsOf: metrics.forwardRateAsOf,
      // Declared and unpaid, apart from the paid history the table and every figure read.
      declaredDividends: data.declared ?? [],
      forwardRateMethod: "Indicated annual cash rate, the one fundamentals use: the latest regular distribution annualized, or once the next one is declared that one, dated by its ex-date (forwardRateAsOf; a date still ahead is the declared distribution's). Only when its currency units are comparable with the share price.",
      paymentFrequencyMethod: "Cadence inferred from ex-dates in the last two years, unavailable when no cash was reported in the last year; not an announced payment schedule.",
    },
  };
}

export function createDividendYieldHeadless(
  dependencies: DividendYieldHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { status: "not-a-feed", basis: "distribution history" },
    argument: {
      kind: "tickers",
      placeholder: "tickers",
      description: "Company symbol, or several to rank in one table by trailing yield.",
      maximum: MAX_RANKED_SYMBOLS,
    },
    options: [
      {
        key: "type",
        shot: REPORT_FILTER,
        description: "Dividend payment type to include.",
        type: "enum",
        values: [
          { value: "all" },
          { value: "cash" },
          { value: "special" },
          { value: "stock" },
          { value: "unknown" },
        ],
        defaultValue: DEFAULT_TYPE,
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
        description: "Maximum historical payments to return.",
        type: "integer",
        defaultValue: DEFAULT_LIMIT,
        minimum: 1,
        maximum: 200,
      },
    ],
    describe: (args) => `Dividend Yield | ${args.symbols.join(", ")}`,
    async load(args, context) {
      // One symbol is its full report; several are one table ranked by yield.
      if (args.symbols.length <= 1) {
        return projectDividendYieldHeadless(await dependencies.loadData(args.symbols[0] ?? String(args.argument), context), args);
      }
      // They choose rows of one ticker's payment history, which a ranking does not list: refused rather than dropped.
      const historyOptions = [
        ...(String(args.options.type ?? DEFAULT_TYPE) !== DEFAULT_TYPE ? ["--type"] : []),
        ...(Number(args.options.limit ?? DEFAULT_LIMIT) !== DEFAULT_LIMIT ? ["--limit"] : []),
      ];
      if (historyOptions.length > 0) {
        throw new Error(`${historyOptions.join(" and ")} ${historyOptions.length === 1 ? "filters" : "filter"} one ticker's payment history, and a ranking of several lists none. Drop ${historyOptions.length === 1 ? "it" : "them"}, or run DVD on one ticker.`);
      }
      const entries = await mapWithConcurrency(args.symbols, RANKING_CONCURRENCY, async (symbol): Promise<DividendRankingEntry> => {
        try {
          return { symbol, data: await dependencies.loadData(symbol, context) };
        } catch (error) {
          return { symbol, error: error instanceof Error ? error.message : String(error) };
        }
      });
      return projectDividendRanking(entries);
    },
  };
}

export const dividendYieldHeadless = createDividendYieldHeadless();
