import type {
  HeadlessBundleResult,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { fetchDividendData, requestDividendHistory, statedForwardRate, type DividendData } from "./client";
import { dividendReferencePrice } from "../../../utils/trailing-dividend";
import type { DividendPayment, GrowthPayments } from "./types";
import { formatDividendYield, growthPaymentsText, PAYOUT_NOT_MEANINGFUL, staleHistoryText, toDividendRows, trailingPaymentsText } from "./view";
import { formatDistributionAmount, formatPercent } from "../../../utils/format";
import { forwardDividendBasis, noCurrentDividend, TRAILING_DIVIDEND_BASIS, UNEVEN_REGULAR_PAYMENTS } from "../../../utils/forward-dividend";
import { currencyPriceMinDigits, formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import type { Quote } from "../../../types/financials";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { dividendPriceStatus, dividendQuotePriceMetadata } from "./reference-price";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { logFailure } from "../../../utils/log-failure";
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

/** Symbols one `fn DVD` ranks at most; it reads them all at once, so a cold ranking takes about as long as its slowest name. */
const MAX_RANKED_SYMBOLS = 25;
const RANKING_CONCURRENCY = MAX_RANKED_SYMBOLS;
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

/** After the amount, for a company declaring in another currency than the listing pays: what it declared. */
const DECLARED_COLUMN = { key: "declared", header: "Declared", align: "right" as const,
  format: (value: unknown, row: Record<string, unknown>) => typeof value === "number" && typeof row.declaredCurrency === "string"
    ? formatDistributionAmount(value, row.declaredCurrency) : "-" };

export interface DividendYieldHeadlessDependencies {
  loadData(symbol: string, context: HeadlessPaneContext): Promise<DividendData>;
  /** A US-listed fund's bond facts (SEC yield, yield to worst, duration); null for any other listing. */
  loadBond?(symbol: string, context: HeadlessPaneContext): Promise<FundBondFacts | null>;
  /** The Treasury par curve GC shows, for the muni/Treasury ratio; null when it cannot be read. */
  loadTreasury?(context: HeadlessPaneContext): Promise<TreasuryTenor[] | null>;
}

/** Already logged at the quote boundary; keep it distinct from absent bond facts. */
class BondClassificationError extends Error {}

const defaultDependencies: DividendYieldHeadlessDependencies = {
  async loadData(symbol, context) {
    let currentPrice: number | null = null;
    let currentPriceCurrency: string | undefined;
    let referenceQuote: Quote | undefined;
    // `ULVR:LSE` is ULVR on LSE, as quote and events read it: the history is asked for that listing, not for a symbol `ULVR:LSE`.
    const instrument = await context.resolveInstrument?.(symbol);
    const listingSymbol = instrument?.symbol ?? symbol;
    const exchange = instrument?.exchange ?? "";
    // The history is asked for beside the quote, not after it: only its yields need the price.
    const history = requestDividendHistory(listingSymbol, exchange);
    try {
      const quote = await context.marketData.getQuote(listingSymbol, exchange);
      // The regular session's price: after the close, the close rather than an after-hours print.
      currentPrice = regularSessionValuationPrice(quote);
      currentPriceCurrency = quote.currency;
      referenceQuote = quote;
    } catch (error) {
      logFailure("dividend-yield.headless", "Read dividend reference quote failed")(error);
      currentPrice = null;
    }
    const data = await fetchDividendData(listingSymbol, currentPrice, exchange, currentPriceCurrency, {
      history,
      // Read only when the summary is missing: the forward rate fundamentals state, as `fundamentals` shows it.
      loadStatedForwardRate: async () => statedForwardRate(await context.marketData.getTickerFinancials(listingSymbol, exchange)),
    });
    if (referenceQuote && dividendReferencePrice(currentPrice, currentPriceCurrency, data.currency ?? "") != null) {
      Object.assign(data, dividendQuotePriceMetadata(referenceQuote));
    }
    return data;
  },
  async loadBond(symbol, context) {
    const instrument = await context.resolveInstrument?.(symbol);
    const exchange = instrument?.exchange ?? "";
    const quote = await context.marketData.getQuote(instrument?.symbol ?? symbol, exchange)
      .catch((error) => {
        logFailure("dividend-yield.headless", "Read bond fund classification quote failed")(error);
        throw new BondClassificationError("Bond fund quote check failed");
      });
    const venue = exchange || quote?.exchangeName || "";
    if (resolveTickerInstrumentKind(null, { quote }) !== "fund" || (venue && !isUsListingExchange(venue))) return null;
    return fetchFundBondFacts(instrument?.symbol ?? symbol, context.apiClient);
  },
  loadTreasury: (context) => loadTreasuryTenors(context.apiClient),
};

/** A growth figure, or what its short year holds: "n/a: 1 of 2 payments". */
function growthText(growth: number | null, payments: GrowthPayments | null | undefined): string {
  return growth == null && payments ? growthPaymentsText(payments) : formatPercent(growth ?? undefined);
}

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
      ...(row.declared ? { declared: row.declared.amount, declaredCurrency: row.declared.currency } : {}),
    };
  });
  const declaredColumns = rows.some((row) => row.declared)
    ? [...PAYMENT_COLUMNS.slice(0, 2), DECLARED_COLUMN, ...PAYMENT_COLUMNS.slice(2)] : PAYMENT_COLUMNS;
  const metrics = data.metrics;
  const currency = data.currency ?? data.payments[0]?.currency ?? "";
  const priceStatus = dividendPriceStatus(data.price, data.priceAsOf, data.priceStale);
  // A regular payer's year with fewer payments than its cadence pays: the yield says how many it counts.
  const shortfall = trailingPaymentsText(metrics.trailingPayments, { cadence: true });
  const errors = [data.historyError, data.summaryError, tax?.checkError].filter((error): error is string => !!error);

  return {
    ...(errors.length > 0 ? { complete: false, errors } : {}),
    sections: [
      {
        title: "Dividend metrics",
        entries: [
          { label: "Price", value: data.price, ...(data.price != null && currency ? { formatted: formatMarketPriceWithCurrency(data.price, currency, { minimumFractionDigits: currencyPriceMinDigits(currency) }) } : {}) },
          ...(data.stale ? [{ label: "History status", value: staleHistoryText(data.fetchedAt) }] : []),
          ...(priceStatus ? [{ label: "Price status", value: priceStatus === "stale"
            ? "Stale reference price; cash yield may be out of date."
            : "Reference price time unavailable; cash yield may be out of date." }] : []),
          { label: bond ? `Trailing distribution yield (${NOT_SEC_YIELD})` : "Trailing yield", value: roundedRatio(metrics.trailingYield),
            formatted: metrics.trailingYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.trailingYield)} (${TRAILING_DIVIDEND_BASIS}${shortfall ? `; counts ${shortfall}` : ""})` },
          { label: bond ? `Forward distribution yield (${NOT_SEC_YIELD})` : "Forward yield", value: roundedRatio(metrics.forwardYield),
            formatted: metrics.lapse ? noCurrentDividend(metrics.lapse)
            : metrics.forwardYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.forwardYield)} (${metrics.forwardBasis === "uneven" ? UNEVEN_REGULAR_PAYMENTS
              : forwardDividendBasis(metrics.forwardRateAsOf, { payDate: forwardPayDate(metrics), declared: data.declared, currency })})` },
          ...(bond ? bondFigures(bond).map((figure) => ({
            label: figure.key === "secYield" ? "30-day SEC yield" : figure.label,
            value: figure.value,
            formatted: `${figure.text}${figure.date ? ` (as of ${figure.date})` : ""}`,
          })) : []),
          { label: "Trailing rate", value: metrics.trailingRate, formatted: currency ? formatDistributionAmount(metrics.trailingRate ?? undefined, currency) : "—" },
          { label: "Forward rate", value: metrics.forwardRate, formatted: currency ? formatDistributionAmount(metrics.forwardRate ?? undefined, currency) : "—" },
          { label: "Earnings Payout", value: roundedRatio(metrics.payoutRatio), formatted: metrics.payoutNotMeaningful ? PAYOUT_NOT_MEANINGFUL : formatDividendYield(metrics.payoutRatio) },
          { label: "1Y Cash Growth", value: roundedRatio(metrics.growth1Y), formatted: growthText(metrics.growth1Y, metrics.growth1YPayments) },
          { label: "3Y Cash CAGR", value: roundedRatio(metrics.growth3Y), formatted: growthText(metrics.growth3Y, metrics.growth3YPayments) },
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
        columns: declaredColumns,
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
      // Set when a regular payer's year holds fewer payments than its cadence pays (a gap in its history): the yield counts only these.
      trailingPayments: metrics.trailingPayments ?? null,
      // Set when a year a growth figure compares holds fewer payments than the cadence pays: that figure is null.
      growth1YPayments: metrics.growth1YPayments ?? null,
      growth3YPayments: metrics.growth3YPayments ?? null,
      forwardRateAsOf: metrics.forwardRateAsOf,
      // "uneven": the year's regular payments differ too widely for one to be annualized, so the forward rate is their total.
      forwardBasis: metrics.forwardBasis ?? null,
      // Declared and unpaid, apart from the paid history the table and every figure read.
      declaredDividends: data.declared ?? [],
      forwardRateMethod: "Indicated annual cash rate, the one fundamentals use: the latest regular distribution annualized, or once the next one is declared that one, dated by its ex-date (forwardRateAsOf; a date still ahead is the declared distribution's). When the trailing year's regular payments differ widely (the largest over 1.5 times the smallest; forwardBasis: uneven), their total instead, dated by the latest. Only when its currency units are comparable with the share price.",
      payoutMethod: "Trailing twelve-month dividends over trailing twelve-month diluted EPS, as the source states it; N/M (not meaningful) when that EPS is zero or negative.",
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
        let bondCheckError: string | undefined;
        const [data, bond, treasury] = await Promise.all([
          dependencies.loadData(symbol, context),
          // Optional enrichment without a tax rate; a requested tax check must distinguish failure from absence.
          dependencies.loadBond?.(symbol, context)
            .catch((error) => {
              if (error instanceof BondClassificationError) {
                bondCheckError = error.message;
              } else {
                logFailure("dividend-yield.headless", "Read bond fund facts for report failed")(error);
                bondCheckError = "Bond fund facts check failed";
              }
              return null;
            }) ?? null,
          rates ? dependencies.loadTreasury?.(context)
            .catch(logFailure("dividend-yield.headless", "Read Treasury curve for tax comparison failed", null)) ?? null : null,
        ]);
        const forward = data.metrics.lapse ? null : distributionBasis(data.metrics.forwardYield, "forward", data.metrics.forwardRateAsOf ?? null);
        const tax = rates ? analyzeTaxEquivalent({
          symbol: symbol.toUpperCase(), bond, rates, treasury, checkError: bondCheckError,
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
        // A fund's bond facts never fail its row: without them it ranks as before.
        const bond = dependencies.loadBond?.(symbol, context)
          .catch((error) => error instanceof BondClassificationError ? null
            : logFailure("dividend-yield.headless", "Read bond fund facts for ranking failed", null)(error)) ?? null;
        try {
          return { symbol, data: await dependencies.loadData(symbol, context), bond: await bond };
        } catch (error) {
          return { symbol, error: error instanceof Error ? error.message : String(error) };
        }
      });
      return projectDividendRanking(entries);
    },
  };
}

export const dividendYieldHeadless = createDividendYieldHeadless();
