import type {
  HeadlessBundleResult,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import { fetchDividendData, requestDividendHistory, statedForwardRate, TOKEN_YIELD_NOTE, type DividendData } from "./client";
import { dividendReferencePrice } from "../../../utils/trailing-dividend";
import type { DividendPayment, GrowthPayments } from "./types";
import {
  carriedDateText, COMBINED_PAYMENT, convertedFromText, dividendAmountDigits, distinctEstimateTexts, formatConvertedAmount, formatDividendYield, growthPaymentsText, PAYOUT_BASIS, PAYOUT_NOT_MEANINGFUL, staleHistoryText, toDividendRows, trailingPaymentsText, trailingSpecialText, type DividendAmountDigits,
} from "./view";
import { MISSING_VALUE, formatDistributionAmount, formatPercent } from "../../../utils/format";
import { NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import { forwardDividendBasis, historyEndsText, noCurrentDividend, TRAILING_DIVIDEND_BASIS, TRAILING_REGULAR_PAYMENTS, UNEVEN_REGULAR_PAYMENTS } from "../../../utils/forward-dividend";
import { currencyPriceMinDigits, formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import type { Quote } from "../../../types/financials";
import { regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import { dividendPriceStatus, dividendQuotePriceMetadata } from "./reference-price";
import { logFailure } from "../../../utils/log-failure";
import { dayFirstTextEntries } from "../shared/day-entries";
import { projectDividendRanking, roundedRatio } from "./ranking";
import { MAX_RANKED_SYMBOLS, readDividendRanking, type DividendRankingReads } from "./ranking-reads";
import { REPORT_FILTER, REPORT_ROWS } from "../shared/headless-options";
import type { FundBondFacts } from "../../../api-client/fund-facts";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { bondClassText, bondFigures, fetchFundBondFacts, NOT_SEC_YIELD, type BondFigure } from "../../../market-data/bond-funds";
import {
  analyzeTaxEquivalent, distributionBasis, loadTreasuryTenors, noBondFigures, parseTaxRates, TAX_RATE_EXAMPLES, TAX_RATE_OPTIONS, taxEquivalentJson,
  taxEquivalentSection, type NoBondFigures, type TaxEquivalentAnalysis, type TreasuryTenor,
} from "../../../market-data/tax-equivalent";

/** The history options' defaults: a ranking lists no history, so only these leave it unchanged. */
const DEFAULT_TYPE = "all";
const DEFAULT_LIMIT = 40;

/**
 * The history's columns; amounts converted from the currency the company
 * declares in are in their source's unit. Each unit's amounts share one
 * precision down the column (`digits`, dividendAmountDigits).
 */
function paymentColumns(converted: boolean, digits: DividendAmountDigits, subUnit?: string) {
  const amount = (value: number, currency: string) => converted
    ? formatConvertedAmount(value, currency, subUnit, digits) : formatDistributionAmount(value, currency, digits.get(currency));
  return [
    { key: "exDate", header: "Ex-date" },
    { key: "amount", header: "Amount", align: "right" as const,
      format: (value: unknown, row: Record<string, unknown>) => typeof value === "number" && typeof row.currency === "string" && row.currency
        ? `${row.cashEstimate ? "estimated " : ""}${amount(value, row.currency)}` : value == null ? MISSING_VALUE : String(value) },
    // As the pane: a currency or type every row shares is no column (the amounts carry the currency).
    { key: "currency", header: "CCY", omitWhenSame: true },
    // A regular payment and an extra one on one ex-date are one row of the history, which says so.
    { key: "type", header: "Type", omitWhenSame: true, format: (value: unknown, row: Record<string, unknown>) => typeof value !== "string" ? MISSING_VALUE
      : row.combined === true ? `${value}, ${COMBINED_PAYMENT}: regular + extra` : value },
  ];
}

/** Last, once a fund's sponsor gave a row its history lacks: who published each row so given. */
const SOURCE_COLUMN = { key: "source", header: "Source",
  format: (value: unknown) => typeof value === "string" ? value : "" };

/** After the amount, for a company declaring in another currency than the listing pays: what it declared, one precision down the column. */
const declaredColumn = (digits: DividendAmountDigits) => ({ key: "declared", header: "Declared", align: "right" as const,
  format: (value: unknown, row: Record<string, unknown>) => typeof value === "number" && typeof row.declaredCurrency === "string"
    ? formatDistributionAmount(value, row.declaredCurrency, digits.get(row.declaredCurrency)) : MISSING_VALUE });

/** What a ticker's read needs: the market data, Gloom Cloud, and the listing a typed key stands for. */
export type DividendReadContext = Pick<HeadlessPaneContext, "marketData" | "apiClient" | "resolveInstrument">;

export interface DividendYieldHeadlessDependencies {
  loadData(symbol: string, context: DividendReadContext): Promise<DividendData>;
  /**
   * A US-listed fund's bond facts (SEC yield, yield to worst, duration), null
   * for a fund without them, or why the listing has none to read
   * (NoBondFigures: not a fund, or a fund listed abroad). Rejects when the
   * check itself fails.
   */
  loadBond?(symbol: string, context: DividendReadContext): Promise<FundBondFacts | NoBondFigures | null>;
  /** The Treasury par curve GC shows, for the muni/Treasury ratio; null when it cannot be read. */
  loadTreasury?(context: HeadlessPaneContext): Promise<TreasuryTenor[] | null>;
}

/** Already logged at the quote boundary; keep it distinct from absent bond facts. */
class BondClassificationError extends Error {}

/** What a failed fund facts read leaves in place of the tax-equivalent yield. */
const BOND_FACTS_CHECK_FAILED = "Bond fund facts check failed";

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
    return noBondFigures(resolveTickerInstrumentKind(null, { quote }), venue) ?? fetchFundBondFacts(instrument?.symbol ?? symbol, context.apiClient);
  },
  loadTreasury: (context) => loadTreasuryTenors(context.apiClient),
};

/**
 * How a ranking reads each ticker: `fn DVD`'s, and the DVD pane's with the
 * app's market data, so both read the same listing at the same price. A
 * fund's bond facts never fail its row: a check that fails is kept on it
 * (`bondError`, in the words single-ticker DVD uses), and without them it
 * ranks as before.
 */
export function dividendRankingReads(
  context: DividendReadContext,
  dependencies: Pick<DividendYieldHeadlessDependencies, "loadData" | "loadBond"> = defaultDependencies,
): DividendRankingReads {
  const { loadBond } = dependencies;
  return {
    loadData: (symbol) => dependencies.loadData(symbol, context),
    ...loadBond ? {
      loadBond: (symbol: string) => loadBond(symbol, context).catch((error) => {
        if (error instanceof BondClassificationError) throw error;
        logFailure("dividend-yield.headless", "Read bond fund facts for ranking failed")(error);
        throw new Error(BOND_FACTS_CHECK_FAILED);
      }),
    } : {},
  };
}

/** A growth figure, N/M off a year that paid nothing, or what its short year holds: "n/a: 1 of 2 payments". */
function growthText(growth: number | null, payments: GrowthPayments | null | undefined, notMeaningful?: boolean): string {
  if (growth == null && notMeaningful) return NOT_MEANINGFUL_TEXT;
  return growth == null && payments ? growthPaymentsText(payments) : formatPercent(growth ?? undefined);
}

const isoDay = (date: Date | null | undefined): string | null => date ? date.toISOString().slice(0, 10) : null;

/** The payout figure's label, naming what it is over as the ranking's title does. */
const PAYOUT_LABEL = `Payout (${PAYOUT_BASIS})`;

/** A date, with the company's other listing it is stated by where it is not this one's: `2026-12-17 (from HSBA:LSE)`. */
function dateEntry(label: string, date: Date | null, listing?: string) {
  return { label, value: date, formatted: date ? `${date.toISOString().slice(0, 10)}${listing ? ` ${carriedDateText(listing)}` : ""}` : "—" };
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
      ...(payment?.combined ? { combined: true } : {}),
      // The issuer's own form's dividend type, where a form types the row ("Final", "Other Special Dividend").
      ...(payment?.formType ? { formType: payment.formType } : {}),
      ...(row.declared ? { declared: row.declared.amount, declaredCurrency: row.declared.currency } : {}),
    };
  });
  // A listing paid in another currency than its company declares (South32's rand) has its amounts converted from that one.
  const convertedFrom = data.convertedFrom;
  const subUnit = data.convertedSubUnit;
  const paymentColumnList = paymentColumns(!!convertedFrom, dividendAmountDigits(rows, !!convertedFrom, subUnit), subUnit);
  const declared = rows.flatMap((row) => typeof row.declared === "number" && row.declaredCurrency ? [{ amount: row.declared, currency: row.declaredCurrency }] : []);
  const historyColumns = [
    ...(declared.length
      ? [...paymentColumnList.slice(0, 2), declaredColumn(dividendAmountDigits(declared)), ...paymentColumnList.slice(2)] : paymentColumnList),
    ...(rows.some((row) => row.source) ? [SOURCE_COLUMN] : []),
  ];
  const metrics = data.metrics;
  const currency = data.currency ?? data.payments[0]?.currency ?? "";
  // A rate from an estimated cash amount says so beside the figure; what it is estimated from is said once, below.
  const cashRate = (value: number | null, estimated = false) => {
    const mark = estimated && value != null ? " estimated" : "";
    return !currency ? "—" : !convertedFrom ? `${formatDistributionAmount(value ?? undefined, currency)}${mark}`
      : value == null ? formatConvertedAmount(value, currency) : `${formatConvertedAmount(value, currency, subUnit)}${mark} (${convertedFromText(convertedFrom)})`;
  };
  const priceStatus = dividendPriceStatus(data.price, data.priceAsOf, data.priceStale);
  // A regular payer's year with fewer payments than its cadence pays: the yield says how many it counts.
  const shortfall = trailingPaymentsText(metrics.trailingPayments, { cadence: true });
  const trailingEstimated = !!metrics.trailingEstimates?.length;
  const forwardEstimated = !!metrics.forwardEstimate;
  const estimateTexts = distinctEstimateTexts([...metrics.trailingEstimates ?? [], ...metrics.forwardEstimate ? [metrics.forwardEstimate] : []]);
  const errors = [data.historyError, data.summaryError, data.cashVerificationWarning, tax?.checkError].filter((error): error is string => !!error);

  // A monthly payer's history that ends early: its yields and last ex-date stop there, and each says so.
  const historyEnd = metrics.lapse?.historyEnds ? metrics.lapse.lastPaid : null;
  const trailingNotes = [TRAILING_DIVIDEND_BASIS, shortfall ? `counts ${shortfall}` : null,
    currency ? trailingSpecialText(metrics, currency) : null, historyEnd ? historyEndsText(historyEnd) : null]
    .filter((note): note is string => !!note).join("; ");
  const trailingLabel = bond ? `Trailing distribution yield (${NOT_SEC_YIELD})` : "Trailing yield";
  const forwardLabel = bond ? `Forward distribution yield (${NOT_SEC_YIELD})` : "Forward yield";
  const forwardText = metrics.lapse ? noCurrentDividend(metrics.lapse) : null;
  // A forward rate that is the trailing year's total (forwardBasis: uneven) says so beside each figure, in exports by its label.
  const trailingForward = metrics.forwardRate != null && metrics.forwardBasis === "uneven";
  const trailingForwardLabel = trailingForward ? ` (${TRAILING_REGULAR_PAYMENTS})` : "";
  // An estimated forward figure is its estimate's, so it carries no dated basis of its own, only that its payments are uneven.
  const forwardBasisText = metrics.forwardBasis === "uneven" ? UNEVEN_REGULAR_PAYMENTS
    : forwardEstimated ? null : forwardDividendBasis(metrics.forwardRateAsOf, { payDate: forwardPayDate(metrics), declared: data.declared, currency });
  const forwardYieldContext = forwardBasisText ? ` (${forwardBasisText})` : "";
  const lastEx = isoDay(metrics.lastExDividendDate);
  const growthEntry = (label: string, value: number | null, payments: GrowthPayments | null | undefined, notMeaningful?: boolean) =>
    ({ label, value: roundedRatio(value), formatted: growthText(value, payments, notMeaningful) });
  const datesAndCash = [
    dateEntry("Last ex-dividend", metrics.lastExDividendDate),
    dateEntry("Next ex-dividend", metrics.nextExDividendDate, metrics.nextExDividendDateListing),
    metrics.nextPayDate ? dateEntry("Next pay", metrics.nextPayDate, metrics.nextPayDateListing) : { label: "Next pay", value: null, formatted: "Unavailable" },
    ...(data.payments.length > 0 && metrics.trailingRate === 0
      ? [{ label: "Cash status", value: "No cash distributions reported in the past 12 months." }] : []),
  ];
  const figures = bond ? bondFigures(bond) : [];
  const figureLabel = (figure: BondFigure) => figure.key === "secYield" ? "30-day SEC yield" : figure.label;
  const priceStatusText = !priceStatus ? null : priceStatus === "stale"
    ? "Stale reference price; cash yield may be out of date."
    : "Reference price time unavailable; cash yield may be out of date.";
  return {
    ...(errors.length > 0 ? { complete: false, errors } : {}),
    sections: [
      {
        title: "Dividend metrics",
        // What the text report says of each figure: its basis, its date and why one is missing, in one line, each day
        // drawn first as the pane draws it; JSON and CSV keep the entries below with their ISO days.
        textEntries: dayFirstTextEntries([
          { label: "Price", value: data.price, ...(data.price != null && currency ? { formatted: formatMarketPriceWithCurrency(data.price, currency, {
            minimumFractionDigits: currencyPriceMinDigits(currency), ...data.priceQuotedUnitDivisor ? { quotedUnitDivisor: data.priceQuotedUnitDivisor } : {} }) } : {}) },
          ...(data.stale ? [{ label: "History status", value: staleHistoryText(data.fetchedAt) }] : []),
          ...(priceStatusText ? [{ label: "Price status", value: priceStatusText }] : []),
          { label: trailingLabel, value: roundedRatio(metrics.trailingYield),
            formatted: metrics.trailingYield == null
              ? data.token ? `${formatDividendYield(null)} (${TOKEN_YIELD_NOTE})` : formatDividendYield(null)
              : `${formatDividendYield(metrics.trailingYield)}${trailingEstimated ? " estimated" : ""} (${trailingNotes})` },
          { label: forwardLabel, value: roundedRatio(metrics.forwardYield),
            formatted: forwardText
            ?? (metrics.forwardYield == null ? formatDividendYield(null)
            : `${formatDividendYield(metrics.forwardYield)}${forwardEstimated ? " estimated" : ""}${forwardYieldContext}`) },
          ...figures.map((figure) => ({
            label: figureLabel(figure),
            value: figure.value,
            formatted: `${figure.text}${figure.date ? ` (as of ${figure.date})` : ""}`,
          })),
          { label: "Trailing rate", value: metrics.trailingRate, formatted: cashRate(metrics.trailingRate, trailingEstimated) },
          { label: "Forward rate", value: metrics.forwardRate, formatted: `${cashRate(metrics.forwardRate, forwardEstimated)}${trailingForward ? ` (${UNEVEN_REGULAR_PAYMENTS})` : ""}` },
          ...estimateTexts.map((estimate) => ({ label: "Estimated", value: estimate })),
          { label: PAYOUT_LABEL, value: roundedRatio(metrics.payoutRatio), formatted: metrics.payoutNotMeaningful ? PAYOUT_NOT_MEANINGFUL : formatDividendYield(metrics.payoutRatio) },
          growthEntry("1Y Cash Growth", metrics.growth1Y, metrics.growth1YPayments, metrics.growth1YNotMeaningful),
          growthEntry("3Y Cash CAGR", metrics.growth3Y, metrics.growth3YPayments, metrics.growth3YNotMeaningful),
          { label: "Frequency", value: metrics.paymentFrequency },
          ...datesAndCash,
        ]),
        // What exports and JSON keep: each figure as a number in its unit, dated by its own observation (the price a
        // yield is over, the day a sponsor gives a figure as of, the ex-date a rate is from), as the multi-fund ranking writes.
        entries: [
          { label: "Price", value: data.price, ...(data.price != null && currency ? { unit: currency } : {}), asOf: data.priceAsOf ?? null },
          ...(data.stale ? [{ label: "History status", value: staleHistoryText(data.fetchedAt), asOf: data.fetchedAt ?? null }] : []),
          ...(priceStatusText ? [{ label: "Price status", value: priceStatusText, asOf: data.priceAsOf ?? null }] : []),
          { label: trailingLabel, value: roundedRatio(metrics.trailingYield), formatted: formatDividendYield(metrics.trailingYield),
            exportUnit: "pct", asOf: metrics.trailingYield == null ? null : data.priceAsOf ?? null },
          { label: `${forwardLabel}${trailingForwardLabel}`, value: roundedRatio(metrics.forwardYield), formatted: metrics.forwardYield == null ? forwardText ?? "—" : formatDividendYield(metrics.forwardYield),
            exportUnit: "pct", asOf: metrics.forwardYield == null ? null : data.priceAsOf ?? null },
          ...figures.map((figure) => figure.key === "duration"
            ? { label: figureLabel(figure), value: figure.value, unit: "years", asOf: bond?.duration?.asOf ?? null }
            : { label: figureLabel(figure), value: figure.value, formatted: figure.text, exportUnit: "pct", asOf: bond?.[figure.key]?.asOf ?? null }),
          { label: "Trailing rate", value: metrics.trailingRate, ...(metrics.trailingRate != null && currency && !convertedFrom ? { unit: currency } : { formatted: cashRate(metrics.trailingRate) }),
            asOf: metrics.trailingRate == null ? null : lastEx },
          { label: `Forward rate${trailingForwardLabel}`, value: metrics.forwardRate, ...(metrics.forwardRate != null && currency && !convertedFrom ? { unit: currency } : { formatted: cashRate(metrics.forwardRate) }),
            asOf: metrics.forwardRate == null ? null : metrics.forwardRateAsOf },
          { label: PAYOUT_LABEL, value: roundedRatio(metrics.payoutRatio), formatted: metrics.payoutNotMeaningful ? PAYOUT_NOT_MEANINGFUL : formatDividendYield(metrics.payoutRatio),
            exportUnit: "pct", asOf: null },
          { ...growthEntry("1Y Cash Growth", metrics.growth1Y, metrics.growth1YPayments, metrics.growth1YNotMeaningful), exportUnit: "pct", asOf: metrics.growth1Y == null ? null : lastEx },
          { ...growthEntry("3Y Cash CAGR", metrics.growth3Y, metrics.growth3YPayments, metrics.growth3YNotMeaningful), exportUnit: "pct", asOf: metrics.growth3Y == null ? null : lastEx },
          { label: "Frequency", value: metrics.paymentFrequency, asOf: null },
          ...datesAndCash.map((entry) => ({ ...entry, asOf: null })),
        ],
      },
      ...(tax ? [taxEquivalentSection(tax)] : []),
      {
        title: convertedFrom ? `Dividend history (amounts ${convertedFromText(convertedFrom)})` : "Dividend history",
        columns: historyColumns,
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
      // The currency the company declares in, when the amounts are converted from it; null for one paid as declared.
      convertedFrom: convertedFrom ?? null,
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
      // Set when the earlier year a growth figure compares paid nothing and the later one paid: that figure is null, N/M.
      growth1YNotMeaningful: metrics.growth1YNotMeaningful === true,
      growth3YNotMeaningful: metrics.growth3YNotMeaningful === true,
      forwardRateAsOf: metrics.forwardRateAsOf,
      forwardRateEstimate: metrics.forwardEstimate ?? null,
      trailingRateEstimates: metrics.trailingEstimates ?? [],
      nextPayDateStatus: metrics.nextPayDate ? "announced" : "unavailable",
      // The company's other listing a date is stated by, where this listing's sources state none (0005:HKEX's pay date is HSBA:LSE's).
      nextPayDateListing: metrics.nextPayDateListing ?? null,
      nextExDividendDateListing: metrics.nextExDividendDateListing ?? null,
      declaredCashAsOf: data.declaredCashAsOf ?? null,
      cashVerificationWarning: data.cashVerificationWarning ?? null,
      // Set when a monthly payer's history stops more than 40 days ago: its forward yield is withheld and its trailing yield counts the history to then.
      historyEnds: metrics.lapse?.historyEnds ? metrics.lapse.lastPaid : null,
      // "uneven": the year's regular payments differ too widely for one to be annualized, so the forward rate is their total.
      forwardBasis: metrics.forwardBasis ?? null,
      // Declared and unpaid, apart from the paid history the table and every figure read.
      declaredDividends: data.declared ?? [],
      forwardRateMethod: "Indicated annual cash rate, the one fundamentals use: the latest regular distribution annualized, or once the next one is declared that one, dated by its ex-date (forwardRateAsOf; a date still ahead is the declared distribution's). When the trailing year's regular payments differ widely (the largest over 1.5 times the smallest; forwardBasis: uneven), their total instead, dated by the latest. Only when its currency units are comparable with the share price.",
      payoutMethod: "Trailing twelve-month dividends over trailing twelve-month diluted EPS: the distributions paid in the last 12 months over the EPS the P/E is on, both in the quote's currency (the source's stated ratio where either cannot be read in it); N/M (not meaningful) when that EPS is zero or negative.",
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
        const [data, bondRead, treasury] = await Promise.all([
          dependencies.loadData(symbol, context),
          // Optional enrichment without a tax rate; a requested tax check must distinguish failure from absence.
          dependencies.loadBond?.(symbol, context)
            .catch((error) => {
              if (error instanceof BondClassificationError) {
                bondCheckError = error.message;
              } else {
                logFailure("dividend-yield.headless", "Read bond fund facts for report failed")(error);
                bondCheckError = BOND_FACTS_CHECK_FAILED;
              }
              return null;
            }) ?? null,
          rates ? dependencies.loadTreasury?.(context)
            .catch(logFailure("dividend-yield.headless", "Read Treasury curve for tax comparison failed", null)) ?? null : null,
        ]);
        // A stock, or a fund listed abroad, has no bond figures, and its tax line says why rather than that none are loaded.
        const bond = typeof bondRead === "string" ? null : bondRead;
        const forward = data.metrics.lapse ? null : distributionBasis(data.metrics.forwardYield, "forward", data.metrics.forwardRateAsOf ?? null);
        const tax = rates ? analyzeTaxEquivalent({
          symbol: symbol.toUpperCase(), bond, rates, treasury, checkError: bondCheckError,
          noBondFigures: typeof bondRead === "string" ? bondRead : null,
          distribution: forward ?? distributionBasis(data.metrics.trailingYield, "trailing"),
        }) : null;
        return projectDividendYieldHeadless(data, args, { bond, tax });
      }
      // They choose rows of one ticker's payment history, which a ranking does not list: refused rather than dropped.
      const historyOptions = [
        ...(String(args.options.type ?? DEFAULT_TYPE) !== DEFAULT_TYPE ? ["--type"] : []),
        ...(Number(args.options.limit ?? DEFAULT_LIMIT) !== DEFAULT_LIMIT ? ["--limit"] : []),
      ];
      if (historyOptions.length > 0) {
        throw new Error(`${historyOptions.join(" and ")} ${historyOptions.length === 1 ? "filters" : "filter"} one ticker's payment history, and a ranking of several lists none. Drop ${historyOptions.length === 1 ? "it" : "them"}, or run DVD on one ticker.`);
      }
      // With --tax-rate each fund's row adds its yield to worst, duration, tax-equivalent yield and muni/Treasury ratio,
      // over the one Treasury curve read beside the funds.
      const [entries, treasury] = await Promise.all([
        readDividendRanking(args.symbols, dividendRankingReads(context, dependencies)),
        rates ? dependencies.loadTreasury?.(context)
          .catch(logFailure("dividend-yield.headless", "Read Treasury curve for tax ranking failed", null)) ?? null : null,
      ]);
      return projectDividendRanking(entries, new Date(), rates ? { rates, treasury } : null);
    },
  };
}

export const dividendYieldHeadless = createDividendYieldHeadless();
