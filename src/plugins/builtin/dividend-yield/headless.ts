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
import type { FundBondFacts } from "../../../api-client/fund-facts";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { isUsListingExchange } from "../../../utils/exchanges";
import { bondClassText, bondFigures, fetchFundBondFacts, NOT_SEC_YIELD } from "../../../market-data/bond-funds";
import {
  analyzeTaxEquivalent, distributionBasis, loadTreasuryTenors, parseTaxRates, TAX_RATE_EXAMPLES, TAX_RATE_OPTIONS, taxEquivalentJson, taxEquivalentLines,
  type TaxEquivalentAnalysis, type TreasuryTenor,
} from "../../../market-data/tax-equivalent";

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
  /** A US-listed fund's bond facts (SEC yield, yield to worst, duration); null for any other listing. */
  loadBond?(symbol: string, context: HeadlessPaneContext): Promise<FundBondFacts | null>;
  /** The Treasury par curve GC shows, for the muni/Treasury ratio; null when it cannot be read. */
  loadTreasury?(context: HeadlessPaneContext): Promise<TreasuryTenor[] | null>;
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
  async loadBond(symbol, context) {
    const instrument = await context.resolveInstrument?.(symbol);
    const exchange = instrument?.exchange ?? "";
    const quote = await context.marketData.getQuote(symbol, exchange).catch(() => undefined);
    const venue = exchange || quote?.exchangeName || "";
    if (resolveTickerInstrumentKind(null, { quote }) !== "fund" || (venue && !isUsListingExchange(venue))) return null;
    return fetchFundBondFacts(instrument?.symbol ?? symbol, context.apiClient);
  },
  loadTreasury: (context) => loadTreasuryTenors(context.apiClient),
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

/**
 * A bond fund's distribution yields say they are not its SEC yield, which
 * follows them with its date, and its yield to worst and duration after it;
 * with `--tax-rate`, a section gives the tax-equivalent yield and the
 * muni/Treasury ratio, each saying what it was computed from.
 */
export function projectDividendYieldHeadless(
  data: DividendData,
  args: HeadlessPaneLoadArgs,
  { bond = null, tax = null }: { bond?: FundBondFacts | null; tax?: TaxEquivalentAnalysis | null } = {},
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
          { label: bond ? `Trailing distribution yield (${NOT_SEC_YIELD})` : "Trailing yield", value: roundedRatio(metrics.trailingYield),
            formatted: metrics.trailingYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.trailingYield)} (${TRAILING_DIVIDEND_BASIS})` },
          { label: bond ? `Forward distribution yield (${NOT_SEC_YIELD})` : "Forward yield", value: roundedRatio(metrics.forwardYield),
            formatted: metrics.lapse ? noCurrentDividend(metrics.lapse)
            : metrics.forwardYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.forwardYield)} (${forwardDividendBasis(metrics.forwardRateAsOf,
              { payDate: forwardPayDate(metrics), declared: data.declared, currency })})` },
          ...(bond ? bondFigures(bond).map((figure) => ({
            label: figure.key === "secYield" ? "30-day SEC yield" : figure.label,
            value: figure.value,
            formatted: `${figure.text}${figure.date ? ` (as of ${figure.date})` : ""}`,
          })) : []),
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
      ...(tax ? [{
        title: "Tax-equivalent yield",
        entries: taxEquivalentLines(tax).map((line) => ({ label: line.label, value: line.value, formatted: line.text })),
      }] : []),
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
      // A bond fund's sponsor figures, each dated; its distribution yields above are not its SEC yield.
      ...(bond ? { bondFund: { ...bond, class: bondClassText(bond) } } : {}),
      ...(tax ? { taxEquivalent: taxEquivalentJson(tax) } : {}),
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
      examples: TAX_RATE_EXAMPLES,
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
      ...TAX_RATE_OPTIONS,
    ],
    describe: (args) => `Dividend Yield | ${args.symbols.join(", ")}`,
    async load(args, context) {
      const rates = parseTaxRates({ taxRate: args.options["tax-rate"], stateRate: args.options["state-rate"], state: args.options.state });
      // One symbol is its full report; several are one table ranked by yield.
      if (args.symbols.length <= 1) {
        const symbol = args.symbols[0] ?? String(args.argument);
        const [data, bond, treasury] = await Promise.all([
          dependencies.loadData(symbol, context),
          // A fund's bond facts never fail the report: without them its yields read as before.
          dependencies.loadBond?.(symbol, context).catch(() => null) ?? null,
          rates ? dependencies.loadTreasury?.(context).catch(() => null) ?? null : null,
        ]);
        const forward = data.metrics.lapse ? null : distributionBasis(data.metrics.forwardYield, "forward", data.metrics.forwardRateAsOf ?? null);
        const tax = rates ? analyzeTaxEquivalent({
          symbol: symbol.toUpperCase(), bond, rates, treasury,
          distribution: forward ?? distributionBasis(data.metrics.trailingYield, "trailing"),
        }) : null;
        return projectDividendYieldHeadless(data, args, { bond, tax });
      }
      if (rates) {
        throw new Error("--tax-rate reads one fund's yield against the Treasury curve, and a ranking of several gives none. Drop it, or run DVD on one ticker.");
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
