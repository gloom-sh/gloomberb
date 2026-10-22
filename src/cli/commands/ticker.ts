import { logFailure } from "../../utils/log-failure";
import { formatShortDate, parseDisplayDate } from "../../utils/datetime-format";
import { formatReportedMoney } from "../../utils/reported-money";
import { convertedPriceEarningsNote, enterpriseValueLabel, enterpriseValueReconciliationNote, epsConversionNote, fundamentalsCurrency, reportedEnterpriseValue, ttmConversionNote } from "../../utils/fundamentals";
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import { burnsCash, cashRunway, SHORT_RUNWAY_HISTORY, formatRunwayMonths, offeringNote, offeringsAfter, runwayMethod, type CashRunway, type OfferingFiling, type RunwayEstimate } from "../../utils/cash-runway";
import { exportedFundamentals, formatPriceEarnings, priceEarningsOnEarnings } from "../../utils/price-earnings";
import { describeFundamentalMarketCap, marketCapShareBasisNote, selectMarketCapitalization } from "../../utils/market-capitalization";
import {
  formatCompact,
  formatCurrency,
  formatCurrencyCode,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "../../utils/format";
import { formatMarketCostWithCurrency, formatMarketPriceWithCurrency, formatMarketQuantity, quoteFormatOptions, withCurrencyMinorDigits, type MarketFormatOptions } from "../../market-data/market/format";
import {
  cliStyles,
  cliTerminalWidth,
  colorBySign,
  renderSection,
  renderStats,
  wrapText,
  type CliStatEntry,
} from "../../utils/cli-output";
import {
  EXTENDED_SESSION_LABELS,
  exchangeShortName,
  getExtendedSessionDisplay,
  getQuoteSessionFields,
  getRegularSessionDisplay,
  quoteBookSessionLabel,
  quoteHeadlineTime,
  quoteMarketStateLabel,
} from "../../market-data/market/status";
import type { FuturesContractTermsPayload } from "../../api-client/futures-curve";
import { changeBasisJson, quoteChangeBasis, quotePreviousCloseDate, quoteSettleText } from "../../market-data/market/change-basis";
import { futuresContractLines, isFuturesInstrument, loadFuturesContractTerms, minorUnitPricePer } from "../../market-data/futures-contract";
import { currencyCodeLabel, heldCurrencyUnit } from "../../utils/currency-units";
import { quotedFxPair } from "../../utils/currency-pair";
import type { AppConfig } from "../../types/config";
import type { CompanyProfile, DeclaredDividendAction, FinancialStatement, Quote, TickerFinancials } from "../../types/financials";
import { atRegularSessionPrice, regularSessionValuationPrice } from "../../market-data/quotes/regular-session-valuation";
import { computeTickerPriceReturns } from "../../market-data/ticker-price-returns";
import { instrumentTypeLabel, resolveTickerInstrumentKind } from "../../tickers/instrument-kind";
import { INDEX_POINTS_LABEL, isIndexLevel, reportedQuoteVolume } from "../../market-data/market/index-level";
import type { SecFilingItem } from "../../types/data-provider";
import type { NewsArticle } from "../../news/types";
import type { TickerRecord } from "../../types/ticker";
import type { CliCommandContext } from "../../types/plugin";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, lotCostFxRate, resolvePortfolioMarketValue, resolvePortfolioPositionPnl } from "../../portfolio/position-metrics";
import { isFuturesTicker } from "../../portfolio/futures-positions";
import { createBaseConverter, type BaseConversion } from "../base-converter";
import { formatFxRate } from "../fx-pair";
import { initMarketData, withMarketData } from "../context";
import { fail } from "../errors";
import type { MarketContext } from "../types";
import {
  formatBidAsk,
  formatFractionPercentCell,
  formatPriceRange,
  formatPortfolioNames,
  formatSignedCurrency,
  formatTimestamp,
  formatWatchlistNames,
  quoteChangeText,
} from "../helpers";
import { NotesFiles } from "../../plugins/builtin/notes/files";
import { isKnownNonUsListing, secFilingItemCodes, US_FUND_FACTS_ONLY } from "../../utils/sec";
import { currentReportItemsLabel, hiddenFilingsNote, loadLatestFilings, type HiddenFilings } from "../../utils/sec-filings";
import { canonicalExchange, exchangeLabel, isKnownExchangeCode, isUsListingExchange } from "../../utils/exchanges";
import {
  failIfNotTraded, failMovedSymbol, ListingArgError, listingChoiceNotes, listingFateLoader, listingIdentity, loadBareVenues,
  resolveCliListing, type CliListing, type ListingDataRequest,
} from "../listing-arg";
import { movedAwayChange } from "../../tickers/ticker-changes";
import { companyMemberships, loadCompanyMemberships, type CompanyMemberships, type ListMembership } from "../issuer-membership";
import { isNotATickerMessage } from "../not-a-ticker";
import { sharesOutstandingInReceipts } from "../../utils/depositary-receipt";
import { cliFreshnessFooter } from "../result";
import { providerMissReason } from "../../sources/provider-errors";
import { exportEntriesTable, reportFooterLines, type CliReportTables } from "../report-tables";
import type { ReportFreshness } from "../pane-functions/freshness";
import { fundamentalsFreshness, quotesFreshness } from "../freshness";
import { distributionHistory, forwardDividendBasis, forwardDividendMayHaveLapsed, lapsedDividend, noCurrentDividend, TRAILING_DIVIDEND_BASIS, type DistributionHistory, type DividendLapse } from "../../utils/forward-dividend";
import { declaredDividends } from "../../utils/declared-dividends";
import { historyTrailingDividendYield, measuresTrailingYield } from "../../market-data/quotes/live-valuation";
import { notTheCoinNote } from "./crypto-hints";
import { loadOfferingFilings, loadStatementFilings, resultsReleaseText, statementPeriodText, type StatementFilingsReport } from "../statement-filings";
import type { BankFiguresPayload } from "../../api-client/bank-figures";
import { bankSection } from "../bank-section";
import type { FundBondFacts } from "../../api-client/fund-facts";
import { bondFigures, fetchFundBondFacts, NOT_SEC_YIELD } from "../../market-data/bond-funds";
import { taxEquivalentLines, type TaxEquivalentAnalysis } from "../../market-data/tax-equivalent";
import { isRoundTheClockCoin } from "../../utils/crypto-pair";
import { coinNewsFallbackNotice } from "../../sources/gloomberb-cloud/news";

const NEWS_ITEM_LIMIT = 5;
const SEC_FILING_LIMIT = 5;

const NOTHING_HIDDEN: HiddenFilings = { pricingSupplements: 0, ownershipReportsAboutOthers: 0 };

/**
 * The company's latest filings, as the report lists them: without a bank's
 * pricing supplements or the 13D/13G it filed as a holder of other
 * companies, unless `all`.
 */
async function loadRecentSecFilings(
  load: (count: number) => Promise<SecFilingItem[]>,
  all: boolean,
): Promise<{ filings: SecFilingItem[]; hidden: HiddenFilings }> {
  return all ? { filings: (await load(SEC_FILING_LIMIT)).slice(0, SEC_FILING_LIMIT), hidden: NOTHING_HIDDEN }
    : loadLatestFilings(load, SEC_FILING_LIMIT, { schedulesAboutOthers: true });
}
// Prose such as a company description stays readable on wide terminals.
const MAX_PROSE_WIDTH = 100;
const METADATA_SEPARATOR = "  ·  ";

interface TickerCommandDependencies {
  /** `--exchange`: the listing, for a symbol that trades in several places. */
  exchange?: string;
  initMarketData?: () => Promise<MarketContext>;
  fail?: (message: string, details?: string) => never;
  printResult?: CliCommandContext["printResult"];
  /** `--all`: the recent SEC filings keep a bank's pricing supplements and its 13D/13G about other companies. */
  allFilings?: boolean;
  /** A futures symbol's contract terms and settlement; a failure leaves them out of the report. */
  futuresContract?: (symbol: string) => Promise<FuturesContractTermsPayload | null>;
}

/**
 * A futures symbol's contract terms and latest confirmed settlement. Any other
 * symbol is not looked up, and a failed request leaves both out of the report.
 */
export async function cliFuturesContract(
  symbol: string,
  instrumentType: string | undefined,
  load: (symbol: string) => Promise<FuturesContractTermsPayload | null> = loadFuturesContractTerms,
): Promise<FuturesContractTermsPayload | null> {
  return isFuturesInstrument(symbol, instrumentType) ? load(symbol).catch(logFailure("cli.commands-ticker", "Read futures contract details failed", null)) : null;
}

/** The Contract block as `ticker` and `quote` print it; a contract past first notice is in the warning colour. */
export function futuresContractMetrics(terms: FuturesContractTermsPayload, symbol: string): Array<[string, string]> {
  return futuresContractLines(terms, symbol).map((line) => [line.label, line.warning ? cliStyles.warning(line.value) : line.value]);
}

function appendMetricSection(lines: string[], title: string, metrics: Array<[string, string]>) {
  const populated = metrics.filter(([, value]) => value !== "—");
  if (populated.length === 0) return;
  if (lines.length > 0) lines.push("");
  lines.push(renderSection(title));
  lines.push(renderStats(populated));
}

/**
 * Out of the regular session the bid and ask say whose book they are: the pre-market or after-hours book beside
 * Last and the extended print, or a closed market's last quote with its day (ITA's $202.00 against $208.74
 * around a $206.65 close is no open book).
 */
function bidAskText(quote: Quote, options: MarketFormatOptions): string {
  const text = formatBidAsk(quote.bid, quote.ask, quote.bidSize, quote.askSize, quote.currency, options);
  const label = text === "—" ? null : quoteBookSessionLabel(quote);
  return label ? `${text}  ${cliStyles.muted(`(${label})`)}` : text;
}

function wrapProse(text: string): string {
  return wrapText(text, Math.min(cliTerminalWidth() ?? MAX_PROSE_WIDTH, MAX_PROSE_WIDTH)).join("\n");
}

/** The runway row: months at the latest quarter's burn and at the trailing year's, each with the period it is read over. */
function cashRunwayText(runway: CashRunway): string {
  const { quarter, trailing, periodEnd } = runway;
  if (quarter?.kind === "no-burn" && trailing?.kind === "no-burn") return `no burn (quarter and TTM to ${periodEnd})`;
  const part = (estimate: RunwayEstimate | null, period: string) => estimate
    ? `${estimate.kind === "no-burn" ? "no burn" : formatRunwayMonths(estimate.months)} (${period} to ${periodEnd})` : null;
  return [part(quarter, "quarter"), trailing ? part(trailing, "TTM") : `TTM ${runway.trailingGap === "short-history" ? SHORT_RUNWAY_HISTORY : "not reported"}`].filter((text): text is string => !!text).join(" \u00b7 ");
}

function buildStatementMetrics(statement: FinancialStatement, currency?: string, codes = false, runway?: CashRunway | null): Array<[string, string]> {
  const money = (value: number | undefined, perShare = false) => formatReportedMoney(value, currency, perShare, codes);
  return [
    ["Revenue", money(statement.totalRevenue)],
    ["Gross Profit", money(statement.grossProfit)],
    ["Operating Income", money(statement.operatingIncome)],
    ["Net Income", money(statement.netIncome)],
    ["Income incl. NCI", money(statement.netIncomeIncludingNoncontrollingInterests)],
    ["Income Common", money(statement.netIncomeCommonStockholders)],
    ["EBITDA", money(statement.ebitda)],
    ["Operating Cash Flow", money(statement.operatingCashFlow)],
    ["Free Cash Flow", money(statement.freeCashFlow)],
    ["Cash", money(statement.cashAndCashEquivalents)],
    ["Cash + ST Inv", money(statement.cashCashEquivalentsAndShortTermInvestments)],
    // The latest quarter's only: months of cash at its burn and the trailing year's.
    ...runway ? [["Cash Runway", cashRunwayText(runway)] as [string, string]] : [],
    ["Total Assets", money(statement.totalAssets)],
    ["Total Liabilities", money(statement.totalLiabilities)],
    ["Total Debt", money(statement.totalDebt)],
    ["Equity", money(statement.totalEquity)],
    ["Diluted EPS", money(statement.eps, true)],
    // Labelled only when the service says the row counts receipts.
    ["Diluted Shares", statement.dilutedShares != null && statement.shareBasis === "depositary_receipt"
      ? `${formatCompact(statement.dilutedShares)} (ADR equivalent)`
      : formatCompact(statement.dilutedShares)],
  ];
}

/**
 * A receipt's count is its ordinary shares expressed in receipts, as its
 * market cap is; the ordinary count follows when the service gives it.
 */
function sharesOutstandingText(fundamentals: TickerFinancials["fundamentals"], inReceipts: boolean): string {
  const shares = fundamentals?.sharesOutstanding;
  if (shares == null || !inReceipts) return formatCompact(shares);
  const ordinary = fundamentals?.shareBasis === "depositary_receipt" ? fundamentals.underlyingOrdinaryShares : undefined;
  return ordinary != null && Number.isFinite(ordinary) && ordinary > 0
    ? `${formatCompact(shares)} (ADR equivalent = ${formatCompact(ordinary)} ordinary shares)`
    : `${formatCompact(shares)} (ADR equivalent)`;
}

/** Provider prose is wrapped; `verbatim` keeps the user's own spacing, such as a table in a note. */
function appendTextSection(lines: string[], title: string, content: string | undefined, verbatim = false) {
  const text = content?.trim();
  if (!text) return;
  lines.push("");
  lines.push(renderSection(title));
  lines.push(verbatim ? text : wrapProse(text));
}

/** "Description from ChinaAMC (Hong Kong), Product Key Facts on HKEXnews: https://...": where a quoted description is from. */
function descriptionSourceLine(profile: CompanyProfile | undefined): string | null {
  const source = profile?.description?.trim() ? profile.descriptionSource : undefined;
  return source?.publisher && source.url ? `Description from ${source.publisher}: ${source.url}` : null;
}

/** The description with where it is from under it, when it is quoted. */
function appendDescription(lines: string[], profile: CompanyProfile | undefined) {
  appendTextSection(lines, "Description", profile?.description);
  const source = descriptionSourceLine(profile);
  if (source) lines.push(cliStyles.muted(source));
}

function appendFeedSection(
  lines: string[],
  title: string,
  entries: Array<{
    title: string;
    meta?: string[];
    body?: string;
    link?: string;
  }>,
  /** What the list leaves out, after its entries. */
  note?: string | null,
) {
  const populated = entries.filter((entry) => entry.title.trim().length > 0);
  if (populated.length === 0) {
    if (note) lines.push("", renderSection(title), cliStyles.muted(note));
    return;
  }

  lines.push("");
  lines.push(renderSection(title));

  for (const [index, entry] of populated.entries()) {
    lines.push(cliStyles.bold(entry.title.trim()));
    const meta = (entry.meta ?? []).filter((value) => value.trim().length > 0);
    if (meta.length > 0) {
      lines.push(cliStyles.muted(meta.join(METADATA_SEPARATOR)));
    }
    if (entry.body?.trim()) {
      lines.push(wrapProse(entry.body.trim()));
    }
    if (entry.link?.trim()) {
      lines.push(cliStyles.muted(entry.link.trim()));
    }
    if (index < populated.length - 1) {
      lines.push("");
    }
  }
  if (note) lines.push("", cliStyles.muted(note));
}

function filingItemsMeta(filing: SecFilingItem): string {
  const items = currentReportItemsLabel(filing.items);
  return items ? `Items ${items}` : "";
}

function normalizeComparable(value: string): string {
  return value.toUpperCase().replace(/\bFORM\b/g, "").replace(/[^A-Z0-9]+/g, "");
}

function getFilingDescription(filing: SecFilingItem): string | undefined {
  const description = filing.primaryDocDescription?.trim();
  if (!description) return undefined;
  if (normalizeComparable(description) === normalizeComparable(filing.form)) {
    return undefined;
  }
  return description;
}

/**
 * SEC filings are asked for unless the listing is known to be outside the US:
 * by the saved ticker, the requested venue, the quote, or the listing the
 * source still describes when it has no current quote. A symbol nothing is
 * known about yet is looked up as a US ticker.
 */
function shouldFetchSecFilings(
  symbol: string,
  exchange: string,
  tickerFile: TickerRecord | null,
  financials: TickerFinancials,
): boolean {
  const saved = tickerFile?.metadata;
  const { quote, quoteMetadata } = financials;
  return !isKnownNonUsListing({
    metadata: {
      ticker: saved?.ticker ?? symbol,
      exchange: saved?.exchange || exchange || quote?.listingExchangeName || quote?.exchangeName
        || quoteMetadata?.listingExchangeName || "",
      currency: saved?.currency || quote?.currency || quoteMetadata?.currency || "",
      name: saved?.name ?? symbol,
      broker_contracts: saved?.broker_contracts,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  });
}

async function appendTickerPositions(lines: string[], tickerFile: TickerRecord | null, quote: TickerFinancials["quote"],
  config: AppConfig, toBase: ReportBaseConverter, rates: ReportRateNotes): Promise<void> {
  const quoteCurrency = quote?.currency?.trim() || tickerFile?.metadata.currency?.trim() || "";
  const codes = writesCurrencyCodes(config);
  const money = codes ? formatCurrencyCode : formatCurrency;
  const converted = new Set<string>();
  if (tickerFile && tickerFile.metadata.positions.length > 0) {
    lines.push("");
    lines.push(renderSection("Positions"));
    const positions = tickerFile.metadata.positions.filter((position) => position.shares !== 0);

    for (const [index, position] of positions.entries()) {
      const portfolioName = config.portfolios.find((portfolio) => portfolio.id === position.portfolio)?.name ?? position.portfolio;
      // A future counts contracts whether or not its lot states their size.
      const contracts = isFuturesTicker(tickerFile) || (position.multiplier ?? 1) > 1;
      const metrics = getPortfolioPositionMetrics({ ...tickerFile, metadata: { ...tickerFile.metadata, positions: [position] } }, undefined, quoteCurrency, undefined, quote);
      const positionCurrency = metrics.positionCurrency;
      const currentPrice = getPortfolioQuoteDisplay(metrics, quote)?.price ?? null;
      const currentPriceBase = currentPrice != null && quoteCurrency ? await toBase(currentPrice, quoteCurrency) : null;
      const positionRate = positionCurrency ? await toBase(1, positionCurrency) : Number.NaN;
      // By the major currency the converter states its rate in: pence (GBp, GBX) at GBP's.
      if (positionCurrency) converted.add(heldCurrencyUnit(positionCurrency).currency);
      if (quoteCurrency && currentPrice != null) converted.add(heldCurrencyUnit(quoteCurrency).currency);
      const baseMetrics = getPortfolioPositionMetrics({ ...tickerFile, metadata: { ...tickerFile.metadata, positions: [position] } }, undefined, quoteCurrency,
        { currency: config.baseCurrency, convert: value => value * positionRate }, quote);
      // A cost bought at an entered rate into the base currency converts at it, as its P&L does, and says so; any other at today's.
      const boughtRate = positionCurrency ? lotCostFxRate(position, positionCurrency, config.baseCurrency) : null;
      const costBasisBase = !positionCurrency ? Number.NaN
        : boughtRate !== null ? baseMetrics.signedCost
        : await toBase(metrics.signedCost, positionCurrency);
      const marketValueBase = resolvePortfolioMarketValue(baseMetrics, currentPriceBase)?.net ?? Number.NaN;
      const selectedPnl = resolvePortfolioPositionPnl(baseMetrics, currentPriceBase);
      const pnl = selectedPnl.value;

      lines.push(cliStyles.bold(`${portfolioName} (${position.broker})`));
      if (!positionCurrency) lines.push(cliStyles.muted("Currency unavailable."));
      const stats: CliStatEntry[] = [
        [
          "Position",
          `${formatMarketQuantity(metrics.totalShares, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency })} ${metrics.priceBasis === "percent-of-par" ? "@" : `${tickerFile.metadata.assetCategory === "BOND" ? "units" : contracts ? "contracts" : "shares"} @`} ${positionCurrency ? formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, currencyCode: codes }) : "—"}`,
        ],
        ["Cost Basis", `${money(costBasisBase, config.baseCurrency)}${boughtRate !== null
          ? ` (${formatFxRate(boughtRate)} ${config.baseCurrency.trim().toUpperCase()} per ${positionCurrency} when bought)` : ""}`],
        ["Market Value", money(marketValueBase, config.baseCurrency)],
        [
          selectedPnl.basis === "broker-snapshot" ? "Broker P&L" : "P&L",
          pnl === null ? "—" : colorBySign(formatSignedCurrency(pnl, config.baseCurrency, codes), pnl),
        ],
      ];
      if (position.markPrice != null) {
        stats.push(["Broker Mark", positionCurrency ? formatMarketPriceWithCurrency(position.markPrice, positionCurrency, { assetCategory: tickerFile.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, currencyCode: codes }) : "—"]);
      }
      lines.push(renderStats(stats));
      if (index < positions.length - 1) {
        lines.push("");
      }
    }
    for (const note of conversionNotes(toBase, converted, rates)) lines.push(cliStyles.muted(note));
  }
}

/** The ticker report's converter: what `createBaseConverter` makes, whose rates a report states; a plain function in tests. */
type ReportBaseConverter = ((value: number, fromCurrency: string) => Promise<number>) & { conversions?(): BaseConversion[] };

/**
 * A base currency other than USD reads every amount with its code (259.36
 * USD, 878.15B CAD): $ alone is also the Canadian, Australian and other
 * dollars. A USD base keeps the signs it always had.
 */
export function writesCurrencyCodes(config: Pick<AppConfig, "baseCurrency"> | undefined): boolean {
  const base = config?.baseCurrency?.trim().toUpperCase();
  return !!base && base !== "USD";
}

/**
 * What the report's rate notes have said and must say: each currency's rate
 * is stated once, under the first section that converted it, and a lot whose
 * cost converts at the rate entered when it was bought is left out of it.
 */
interface ReportRateNotes {
  /** Currencies whose rate a note already gave. */
  noted: Set<string>;
  /** Currencies of lots whose Cost Basis is at their own entered rate. */
  boughtAt: ReadonlySet<string>;
}

/** The currencies of the shown lots whose cost converts into the base currency at the rate they were bought at, pence as GBP. */
function boughtRateCurrencies(tickerFile: TickerRecord | null, quoteCurrency: string, baseCurrency: string): Set<string> {
  return new Set((tickerFile?.metadata.positions ?? []).flatMap((position) => {
    const currency = (position.currency || quoteCurrency).trim();
    return position.shares !== 0 && currency && lotCostFxRate(position, currency, baseCurrency) !== null ? [heldCurrencyUnit(currency).currency] : [];
  }));
}

/**
 * "CAD figures at USD/CAD 1.40623, as of 2026-10-21 04:46 UTC.": the rate
 * and its date for each currency in `currencies` the report converted into
 * the base currency, as markets quote the pair (USD/JPY, not JPY/USD), so a
 * converted figure is never without what it was converted at. A rate already
 * stated is not repeated, and a cost basis at its own rate is excepted.
 */
function conversionNotes(toBase: ReportBaseConverter, currencies: ReadonlySet<string>, rates: ReportRateNotes): string[] {
  return (toBase.conversions?.() ?? [])
    .filter((conversion) => currencies.has(conversion.currency) && conversion.currency !== conversion.baseCurrency && !rates.noted.has(conversion.currency))
    .map(({ currency, baseCurrency, rate, asOf }) => {
      rates.noted.add(currency);
      const quoted = quotedFxPair(currency, baseCurrency, rate);
      const except = rates.boughtAt.has(currency) ? ", except a cost basis at the rate it was bought at" : "";
      return `${baseCurrency} figures at ${quoted.pair} ${formatFxRate(quoted.rate)}${asOf != null ? `, as of ${formatTimestamp(asOf)}` : ""}${except}.`;
    });
}

/** A source's enterprise value is in the units of the capitalization it reports beside it,
 * which without a declared unit is the listing's quote currency (as the overview labels it). */
function enterpriseValueCurrency(
  quote: TickerFinancials["quote"],
  fundamentals: TickerFinancials["fundamentals"],
): string | undefined {
  return fundamentals?.marketCapCurrency?.trim()
    || selectMarketCapitalization(quote, fundamentals)?.currency
    || quote?.currency?.trim()
    || undefined;
}

/** A fundamentals line: the text the report prints, and for CSV the figure behind it in `unit`. */
interface FundamentalsMetric {
  label: string;
  text: string;
  value?: number | string | null;
  unit?: string;
  /** A figure the text prints inside another line, which CSV gives a row of its own. */
  exportOnly?: boolean;
}

type MetricFigure = Omit<FundamentalsMetric, "label">;

/** An amount in the currency the source reported it in; `ccy?` when it named none, as the text says. `codes`: per share too (6.54 USD). */
function reportedMoney(value: number | undefined, currency: string | undefined, perShare = false, codes = false): MetricFigure {
  return { text: formatReportedMoney(value, currency, perShare, codes), value, unit: currency?.trim() || "ccy?" };
}

/** The EV line: labelled "(provider)" when it is more than 5% from market cap + debt - cash, "unavailable" when withdrawn. */
function enterpriseValueFigure(figure: MetricFigure, fundamentals: TickerFinancials["fundamentals"]): MetricFigure {
  const label = enterpriseValueLabel(fundamentals);
  if (label === "unavailable") return { text: "unavailable", value: null, unit: figure.unit };
  return label === "provider" && figure.text !== "—" ? { ...figure, text: `${figure.text} (provider)` } : figure;
}

function percentFigure(fraction: number | null | undefined, format: (value: number) => string): MetricFigure {
  return fraction != null ? { text: format(fraction), value: fraction * 100, unit: "%" } : { text: "—" };
}

/**
 * The listing's distributions a dividend yield is read with: the declared,
 * unpaid ones a forward yield dated ahead is named from, in their own
 * currency, the history that says whether the dividend is still paid, and the
 * trailing yield DVD reads from that history.
 */
export interface DividendDistributions {
  rows: DeclaredDividendAction[];
  currency?: string;
  history: DistributionHistory | null;
  /**
   * A trailing yield as DVD measures it (historyTrailingDividendYield): the history's
   * trailing twelve-month cash over the quote's regular session price. Null
   * when the history is not whole or the price is in another currency, which
   * leaves the yield Gloom Cloud serves; absent for a forward yield.
   */
  trailingYield?: number | null;
}

/**
 * The listing's distributions, read for a trailing yield, which is measured
 * from them as DVD measures it, and for a forward yield whose ex-date is still
 * ahead (the one case its basis names a declared one, which JSON does not
 * print, so `declared: false` skips it) or long enough past for its dividend
 * to have stopped; null otherwise, and when they cannot be read, which leaves
 * the trailing yield Gloom Cloud serves, the forward basis to its dates and
 * the lapse to Gloom Cloud's fifteen months.
 */
export async function loadDividendDistributions(
  dataProvider: Pick<MarketContext["dataProvider"], "getCorporateActions">,
  listing: { symbol: string; exchange: string },
  { quote, fundamentals }: Pick<TickerFinancials, "quote" | "fundamentals">,
  { declared = true, now = new Date() }: { declared?: boolean; now?: Date } = {},
): Promise<DividendDistributions | null> {
  if (fundamentals?.dividendYield == null || !dataProvider.getCorporateActions) return null;
  const trailing = measuresTrailingYield(fundamentals);
  if (!trailing) {
    if (fundamentals.dividendYieldBasis !== "forward") return null;
    const exDate = fundamentals.exDividendDate ?? "";
    const declaredAhead = declared && /^\d{4}-\d{2}-\d{2}$/.test(exDate) && exDate > now.toISOString().slice(0, 10);
    if (!declaredAhead && !forwardDividendMayHaveLapsed(exDate, now)) return null;
  }
  try {
    const actions = await dataProvider.getCorporateActions(listing.symbol, listing.exchange);
    return { rows: declaredDividends(actions, now), ...(actions.currency ? { currency: actions.currency } : {}),
      history: distributionHistory(actions, now), ...(trailing ? { trailingYield: historyTrailingDividendYield(actions, quote, now) } : {}) };
  } catch (error) {
    logFailure("cli.commands-ticker", "Read dividend distributions failed")(error);
    return null;
  }
}

/** The stopped dividend behind a forward yield, if it has stopped (lapsedDividend); null for any other yield. */
function forwardYieldLapse(
  fundamentals: TickerFinancials["fundamentals"],
  distributions: DividendDistributions | null,
  now = new Date(),
): DividendLapse | null {
  return fundamentals?.dividendYieldBasis === "forward" && fundamentals.dividendYield != null
    ? lapsedDividend(fundamentals.exDividendDate, distributions?.history, now) : null;
}

/**
 * The dividend yield a report shows: a trailing one as DVD measures it from
 * the cash history (DividendDistributions.trailingYield), so `fundamentals`,
 * `ticker` and DVD print one figure; Gloom Cloud's when that cannot be read,
 * and a forward one as served.
 */
function reportedDividendYield(
  fundamentals: Pick<NonNullable<TickerFinancials["fundamentals"]>, "dividendYield" | "dividendYieldBasis"> | undefined,
  distributions: DividendDistributions | null,
): number | undefined {
  const measured = fundamentals?.dividendYieldBasis === "trailing" ? distributions?.trailingYield : null;
  return measured ?? fundamentals?.dividendYield;
}

/**
 * A dividend yield says its basis in the words DVD uses: a forward yield what
 * it annualizes and when (a declared distribution by its ex-date and stated
 * amount), and once its dividend has stopped, that there is none and when it
 * was last paid; a trailing one the twelve months it covers. A yield of no
 * stated basis is the figure alone.
 */
function forwardYieldFigure(fundamentals: TickerFinancials["fundamentals"], distributions: DividendDistributions | null): MetricFigure {
  const lapse = forwardYieldLapse(fundamentals, distributions);
  if (lapse) return { text: noCurrentDividend(lapse), value: null };
  const figure = percentFigure(reportedDividendYield(fundamentals, distributions), formatFractionPercentCell);
  if (fundamentals?.dividendYield == null) return figure;
  const basis = fundamentals.dividendYieldBasis === "forward"
    ? forwardDividendBasis(fundamentals.exDividendDate, { declared: distributions?.rows, currency: distributions?.currency })
    : fundamentals.dividendYieldBasis === "trailing" ? TRAILING_DIVIDEND_BASIS : null;
  return basis ? { ...figure, text: `${figure.text} (${basis})` } : figure;
}

/**
 * Fundamentals as JSON exports them: a trailing yield as the text reads it
 * (reportedDividendYield), and a forward yield whose dividend has stopped
 * null, as is its rate, with the last ex-date under `dividendLapse`.
 */
export function exportedDividendFundamentals<T extends object & Pick<NonNullable<TickerFinancials["fundamentals"]>, "dividendYield" | "dividendYieldBasis" | "exDividendDate">>(
  fundamentals: T,
  distributions: DividendDistributions | null,
): T | (Omit<T, "dividendYield" | "dividendRate"> & { dividendYield: null; dividendRate: null; dividendLapse: DividendLapse }) {
  const lapse = forwardYieldLapse(fundamentals, distributions);
  if (lapse) return { ...fundamentals, dividendYield: null, dividendRate: null, dividendLapse: lapse };
  const dividendYield = reportedDividendYield(fundamentals, distributions);
  return dividendYield === fundamentals.dividendYield ? fundamentals : { ...fundamentals, dividendYield };
}

/**
 * `Dividend Yield (forward)`, or for a bond fund `Distribution Yield (forward,
 * not SEC yield)`: the cash it paid, annualized, which its SEC yield (the line
 * after it) is not.
 */
function dividendYieldLabel(basis: string | undefined, bond: FundBondFacts | null): string {
  if (bond) return `Distribution Yield (${basis ? `${basis}, ` : ""}${NOT_SEC_YIELD})`;
  return `Dividend Yield${basis ? ` (${basis})` : ""}`;
}

/** The labels a bond fund's sponsor figures print under, after its distribution yield. */
const BOND_METRIC_LABELS = { secYield: "30-Day SEC Yield", yieldToWorst: "Yield to Worst" } as const;

/**
 * A bond fund's 30-day SEC yield, yield to worst and duration as its sponsor
 * publishes them, each dated: `4.04% (as of 2026-10-15)`.
 */
function bondFundMetrics(bond: FundBondFacts | null): FundamentalsMetric[] {
  if (!bond) return [];
  return bondFigures(bond).map((figure) => ({
    label: figure.key === "duration" ? (bond.duration?.measure === "average" ? "Average Duration" : "Effective Duration") : BOND_METRIC_LABELS[figure.key],
    text: `${figure.text}${figure.date ? ` (as of ${figure.date})` : ""}`,
    value: figure.value,
    unit: figure.key === "duration" ? "years" : "%",
  }));
}

/** Whether a metric is a yield line, which `valuation` keeps beside the multiples. */
function isYieldMetric(label: string): boolean {
  return label.startsWith("Dividend Yield") || label.startsWith("Distribution Yield") || label === BOND_METRIC_LABELS.secYield;
}

/**
 * A US-listed fund's bond facts for the yield lines; null for any other
 * listing, and when they cannot be read, which leaves the yield as it was.
 */
export async function loadReportBondFacts(
  symbol: string,
  exchange: string | undefined,
  financials: Pick<TickerFinancials, "quote" | "quoteMetadata">,
  tickerFile: TickerRecord | null = null,
  load: (symbol: string) => Promise<FundBondFacts | null> = fetchFundBondFacts,
): Promise<FundBondFacts | null> {
  if (resolveTickerInstrumentKind(tickerFile, financials) !== "fund" || (exchange && !isUsListingExchange(exchange))) return null;
  try {
    return await load(symbol);
  } catch (error) {
    logFailure("cli.commands-ticker", "Read bond fund facts failed")(error);
    return null;
  }
}

function multipleFigure(value: ReturnType<typeof priceEarningsOnEarnings> | number | undefined): MetricFigure {
  const text = formatPriceEarnings(value, 2);
  return { text, value: typeof value === "number" && Number.isFinite(value) && value > 0 ? value : text === "N/M" ? text : null };
}

function fundamentalsMetrics(
  quote: TickerFinancials["quote"],
  fundamentals: TickerFinancials["fundamentals"],
  profile: TickerFinancials["profile"],
  marketCap: MetricFigure,
  priceReturns: { return1Y?: number | null; return3Y?: number | null },
  reportingCurrency: string | undefined,
  enterpriseValue = reportedMoney(reportedEnterpriseValue(fundamentals), enterpriseValueCurrency(quote, fundamentals)),
  distributions: DividendDistributions | null = null,
  bond: FundBondFacts | null = null,
  codes = false,
): FundamentalsMetric[] {
  const signed = (value: number) => colorBySign(formatPercent(value), value);
  const receipt = fundamentals?.sharesOutstanding != null && sharesOutstandingInReceipts(quote, fundamentals, profile?.description);
  return [
    { label: "Market Cap", ...marketCap },
    { label: "Enterprise Value", ...enterpriseValueFigure(enterpriseValue, fundamentals) },
    // A multiple over a loss is N/M, even beside a positive one the source served from an older period.
    { label: "P/E (TTM)", ...multipleFigure(priceEarningsOnEarnings(fundamentals?.trailingPE, fundamentals?.eps)) },
    { label: "Forward P/E", ...multipleFigure(priceEarningsOnEarnings(fundamentals?.forwardPE, fundamentals?.forwardEps)) },
    { label: "PEG", ...multipleFigure(fundamentals?.pegRatio) },
    // The flows and EPS are one trailing-twelve-month block, the same twelve months for each line.
    { label: "EPS (TTM)", ...reportedMoney(fundamentals?.eps, fundamentals?.epsCurrency?.trim() || reportingCurrency, true, codes) },
    {
      label: dividendYieldLabel(fundamentals?.dividendYieldBasis, bond),
      ...forwardYieldFigure(fundamentals, distributions),
    },
    ...bondFundMetrics(bond),
    { label: "Revenue (TTM)", ...reportedMoney(fundamentals?.revenue, reportingCurrency) },
    { label: "Net Income (TTM)", ...reportedMoney(fundamentals?.netIncome, reportingCurrency) },
    { label: "Operating Cash Flow (TTM)", ...reportedMoney(fundamentals?.operatingCashFlow, reportingCurrency) },
    { label: "Free Cash Flow (TTM)", ...reportedMoney(fundamentals?.freeCashFlow, reportingCurrency) },
    // Levels, not changes, so they carry no sign.
    { label: "Operating Margin", ...percentFigure(fundamentals?.operatingMargin, formatFractionPercentCell) },
    { label: "Profit Margin", ...percentFigure(fundamentals?.profitMargin, formatFractionPercentCell) },
    { label: "Revenue Growth", ...percentFigure(fundamentals?.revenueGrowth, signed) },
    { label: "Last Quarter Growth", ...percentFigure(fundamentals?.lastQuarterGrowth, signed) },
    { label: "1Y Return", ...percentFigure(priceReturns.return1Y, signed) },
    { label: "3Y Return", ...percentFigure(priceReturns.return3Y, signed) },
    {
      label: "Shares Outstanding",
      text: sharesOutstandingText(fundamentals, receipt),
      value: fundamentals?.sharesOutstanding,
      ...(receipt ? { unit: "ADR equivalent" } : {}),
    },
  ];
}

/**
 * The float and the short interest `fundamentals` prints after the share count: the shares short, short % of float
 * and days to cover of one settlement, dated, as the JSON gives them and `SI` and `SIW` show them.
 */
function floatAndShortInterestMetrics(
  quote: TickerFinancials["quote"],
  fundamentals: TickerFinancials["fundamentals"],
  profile: TickerFinancials["profile"],
): FundamentalsMetric[] {
  const finite = (value: number | undefined): value is number => value != null && Number.isFinite(value);
  const float = fundamentals?.floatShares;
  const short = fundamentals?.sharesShort;
  const days = fundamentals?.shortRatio;
  const date = fundamentals?.shortInterestDate;
  const receipt = finite(float) && sharesOutstandingInReceipts(quote, fundamentals, profile?.description);
  return [
    finite(float) && float > 0
      ? { label: "Float", text: formatCompact(float), value: float, ...(receipt ? { unit: "ADR equivalent" } : {}) }
      : { label: "Float", text: "—" },
    finite(short)
      ? { label: "Short Interest", text: `${formatCompact(short)}${date ? ` (settled ${date})` : ""}`, value: short, unit: "shares" }
      : { label: "Short Interest", text: "—" },
    ...finite(short) && date ? [{ label: "Short Interest Settlement", text: date, value: date, exportOnly: true }] : [],
    { label: "Short % of Float", ...percentFigure(fundamentals?.shortPercentOfFloat, formatFractionPercentCell) },
    finite(days) ? { label: "Days to Cover", text: formatNumber(days, 2), value: days } : { label: "Days to Cover", text: "—" },
  ];
}

function metricLines(metrics: readonly FundamentalsMetric[]): Array<[string, string]> {
  return metrics.filter((metric) => !metric.exportOnly).map((metric) => [metric.label, metric.text]);
}

const TRAILING_MONEY_METRICS = new Set(["EPS (TTM)", "Revenue (TTM)", "Net Income (TTM)", "Operating Cash Flow (TTM)", "Free Cash Flow (TTM)"]);

/**
 * The notes under shown fundamentals: a market cap that does not rest on the share count shown, how a labelled or
 * withdrawn EV compares with market cap + debt - cash, what a converted TTM block was converted from, an EPS in
 * another currency than the amounts beside it, and what a P/E on such an EPS divides. `priced` is the snapshot at
 * the regular session price (atRegularSessionPrice), the figures the lines show, so each note reads those.
 */
function fundamentalsNotes(
  priced: Pick<TickerFinancials, "quote" | "fundamentals">,
  metrics: readonly FundamentalsMetric[],
  quoteCurrency: string | undefined,
): string[] {
  const fundamentals = priced.fundamentals;
  const shown = (label: string) => metrics.some((metric) => metric.label === label && metric.text !== "—");
  const shareBasis = shown("Market Cap") && shown("Shares Outstanding")
    ? marketCapShareBasisNote(selectMarketCapitalization(priced.quote, fundamentals), fundamentals?.sharesOutstanding,
      regularSessionValuationPrice(priced.quote), priced.quote?.currency)
    : undefined;
  const conversion = [...TRAILING_MONEY_METRICS].some(shown) ? ttmConversionNote(fundamentals) : undefined;
  const eps = shown("EPS (TTM)") ? epsConversionNote(fundamentals) : undefined;
  const priceEarnings = metrics.some((metric) => metric.label === "P/E (TTM)" && typeof metric.value === "number")
    ? convertedPriceEarningsNote(fundamentals, quoteCurrency)
    : undefined;
  const enterpriseValue = shown("Enterprise Value") ? enterpriseValueReconciliationNote(fundamentals) : undefined;
  return [shareBasis, enterpriseValue, conversion, eps, priceEarnings].filter((note): note is string => !!note);
}

// The share count is the market cap's basis: the cap is the count times the price, or a note says why not.
const VALUATION_METRICS = new Set(["Market Cap", "Shares Outstanding", "Enterprise Value", "P/E (TTM)", "Forward P/E", "PEG", "EPS (TTM)"]);

type FundamentalsReportData = TickerFinancials & {
  symbol: string;
  exchange?: string;
  distributions?: DividendDistributions | null;
  /** A bond fund's SEC yield, yield to worst and duration (loadReportBondFacts). */
  bondFund?: FundBondFacts | null;
  /** `fundamentals --tax-rate`: the tax-equivalent yield and muni/Treasury ratio. */
  taxEquivalent?: TaxEquivalentAnalysis | null;
  /** The filings behind the latest statements, and a newer quarter's results release. */
  statementFilings?: StatementFilingsReport | null;
  /** A bank holding company's deposits, uninsured share and CRE (`fundamentals` only). */
  bank?: BankFiguresPayload | null;
  /** In place of `bank`, for a bank whose figures could not be read. */
  bankNote?: string | null;
  /** A base currency other than USD: every amount reads with its code (`writesCurrencyCodes`). */
  currencyCodes?: boolean;
};

/** "Latest quarter 2026-06-30, 10-Q filed 2026-08-06." and the newer quarter's results release, for the lines under a report's figures. */
function statementFilingsNotes(report: StatementFilingsReport | null | undefined): string[] {
  if (!report) return [];
  const latest = report.latestQuarter ?? report.latestAnnual;
  return [
    ...latest ? [`Latest ${report.latestQuarter ? "quarter" : "annual period"} ${statementPeriodText(latest.date, latest)}.`] : [],
    ...report.resultsRelease ? [resultsReleaseText(report.resultsRelease)] : [],
  ];
}

/**
 * Where a fund's facts are: for a US listing, the ETF function (fee, NAV,
 * premium, net assets); a fund listed elsewhere has none yet. Only for a
 * fund: a stock's report says nothing of it.
 */
function fundFactsNote(
  symbol: string,
  exchange: string | undefined,
  financials: Pick<TickerFinancials, "quote" | "quoteMetadata">,
  tickerFile: TickerRecord | null = null,
): string | null {
  if (resolveTickerInstrumentKind(tickerFile, financials) !== "fund") return null;
  return !exchange || isUsListingExchange(exchange)
    ? `Fund facts (fee, NAV, premium, net assets): fn ETF ${symbol}.`
    : US_FUND_FACTS_ONLY;
}

/**
 * The price a valuation is measured at, as `quote` and `ticker` read it: Last
 * and Change are the regular session (after the close, its close and that
 * close's move), and a pre-market, after-hours or overnight print is a line
 * of its own, measured from that close.
 */
function valuationPriceMetrics(financials: FundamentalsReportData): FundamentalsMetric[] {
  const quote = financials.quote;
  const session = getRegularSessionDisplay(quote);
  if (!quote || !session) return [];
  const options = withCurrencyMinorDigits({
    ...quoteFormatOptions(quote, undefined, financials.quoteMetadata?.instrumentType),
    ...financials.currencyCodes ? { currencyCode: true } : {},
  }, quote.currency);
  const price = (value: number) => formatMarketPriceWithCurrency(value, quote.currency, options);
  const extended = getExtendedSessionDisplay(quote);
  const extendedLabel = extended ? EXTENDED_SESSION_LABELS[extended.session] : "";
  return [
    { label: "Last", text: price(session.price), value: session.price, unit: quote.currency },
    session.changePercent != null && Number.isFinite(session.changePercent)
      ? {
        label: "Change",
        // With what the move is measured from, as `ticker` and `quote` say it: "vs Fri 16 Oct close".
        text: quoteChangeText(quote, session, options),
        value: session.changePercent,
        unit: "%",
      }
      : { label: "Change", text: "—" },
    ...extended ? [
      {
        label: extendedLabel,
        // "mid" when the overnight price is the session's bid and ask midpoint, as `quote` marks it.
        text: colorBySign(`${price(extended.price)}${extended.mark ? " mid" : ""}${extended.changePercent != null ? ` (${formatPercentRaw(extended.changePercent)})` : ""}`, extended.change),
        value: extended.price,
        unit: quote.currency,
      },
      extended.changePercent != null
        ? { label: `${extendedLabel} Change`, text: formatPercentRaw(extended.changePercent), value: extended.changePercent, unit: "%", exportOnly: true }
        : { label: `${extendedLabel} Change`, text: "—" },
    ] : [],
  ];
}

/**
 * The lines `fundamentals` or `valuation` reports, the ones with a value.
 * Market cap, the P/E multiples and the dividend yield are measured at the
 * regular session price (atRegularSessionPrice), which `valuation` names in
 * its first lines.
 */
function fundamentalsReportMetrics(snapshot: FundamentalsReportData, view: "fundamentals" | "valuation"): FundamentalsMetric[] {
  const financials = atRegularSessionPrice(snapshot);
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const capitalization = selectMarketCapitalization(quote, fundamentals);
  const marketCap: MetricFigure = capitalization
    ? { text: `${formatCompact(capitalization.value)} ${capitalization.currency}`, value: capitalization.value, unit: capitalization.currency }
    : { text: "—" };
  const metrics = fundamentalsMetrics(quote, fundamentals, financials.profile, marketCap, computeTickerPriceReturns(financials), fundamentalsCurrency(financials),
    undefined, snapshot.distributions ?? null, snapshot.bondFund ?? null, snapshot.currencyCodes === true);
  if (view === "fundamentals") {
    return [...metrics, ...floatAndShortInterestMetrics(quote, fundamentals, financials.profile)]
      .filter((metric) => metric.text !== "—");
  }
  const valued = metrics.filter(({ label, text }) => (VALUATION_METRICS.has(label) || isYieldMetric(label)) && text !== "—");
  // The share count follows the market cap it is the basis of.
  const shares = valued.filter((metric) => metric.label === "Shares Outstanding");
  const valuation = valued.flatMap((metric) => metric.label === "Shares Outstanding" ? [] : metric.label === "Market Cap" ? [metric, ...shares] : [metric]);
  // A listing with no valuation (a fund) says so rather than printing its price alone.
  return valuation.length === 0 ? [] : [...valuationPriceMetrics(financials).filter((metric) => metric.text !== "—"), ...valuation];
}

/** Text for `gloomberb fundamentals` and `gloomberb valuation`: the ticker report's fundamentals without the rest. */
export function renderFundamentalsReport(
  financials: FundamentalsReportData,
  view: "fundamentals" | "valuation",
): string {
  const quote = financials.quote;
  const profile = financials.profile;
  const symbol = quote?.symbol ?? financials.symbol;
  const name = quote?.name && quote.name !== symbol ? ` ${cliStyles.bold(quote.name)}` : "";
  const lines = [`${cliStyles.accent(symbol)}${name}`];
  const profileParts = [
    financials.exchange ? exchangeLabel(financials.exchange) : undefined,
    profile?.sector ? `Sector ${profile.sector}` : undefined,
    profile?.industry ? `Industry ${profile.industry}` : undefined,
  ].filter((part): part is string => !!part);
  if (profileParts.length > 0) lines.push(cliStyles.muted(profileParts.join(METADATA_SEPARATOR)));

  const before = lines.length;
  const metrics = fundamentalsReportMetrics(financials, view);
  appendMetricSection(lines, view === "valuation" ? "Valuation" : "Fundamentals", metricLines(metrics));
  const fund = fundFactsNote(symbol, financials.exchange || quote?.exchangeName, financials);
  if (lines.length === before) lines.push("", cliStyles.muted([`No ${view} reported for ${financials.symbol}.`, fund].filter(Boolean).join(" ")));
  else if (fund) lines.push(cliStyles.muted(fund));
  for (const note of fundamentalsNotes(atRegularSessionPrice(financials), metrics, quote?.currency)) lines.push(cliStyles.muted(note));
  if (view === "fundamentals") {
    if (financials.taxEquivalent) {
      appendMetricSection(lines, "Tax-Equivalent Yield", taxEquivalentLines(financials.taxEquivalent).map((line) => [line.label, line.text]));
    }
    for (const note of statementFilingsNotes(financials.statementFilings)) lines.push(cliStyles.muted(note));
    const bank = financials.bank ? bankSection(financials.bank, symbol, bankSectionContext(financials)) : null;
    if (bank) {
      appendMetricSection(lines, "Bank", bank.lines);
      for (const note of bank.notes) lines.push(cliStyles.muted(note));
    } else if (financials.bankNote) {
      lines.push("", renderSection("Bank"), cliStyles.muted(financials.bankNote));
    }
    appendDescription(lines, profile);
  }
  return lines.join("\n");
}

/** What the Bank section reads from the rest of the report: the newest statement period, and the annual report form. */
function bankSectionContext(financials: FundamentalsReportData) {
  return {
    latestStatementDate: [...financials.quarterlyStatements, ...financials.annualStatements].map((row) => row.date).sort().at(-1) ?? null,
    annualReportForm: financials.statementFilings?.annualReportForm ?? null,
  };
}

/**
 * `fundamentals` and `valuation` for `--csv` and `--ndjson`: the metrics as
 * `Metric,Value` with each unit in its label, and for `fundamentals` the
 * company profile the text prints around them.
 */
export function fundamentalsReportTables(
  financials: FundamentalsReportData,
  view: "fundamentals" | "valuation",
  freshness: ReportFreshness,
): CliReportTables {
  const metrics = fundamentalsReportMetrics(financials, view);
  const fund = fundFactsNote(financials.quote?.symbol ?? financials.symbol, financials.exchange || financials.quote?.exchangeName, financials);
  const tables = [exportEntriesTable(
    view === "valuation" ? "Valuation" : "Fundamentals",
    metrics.map((metric) => ({ label: metric.label, value: metric.value, formatted: metric.text, unit: metric.unit })),
  )];
  const bank = view === "fundamentals" && financials.bank
    ? bankSection(financials.bank, financials.quote?.symbol ?? financials.symbol, bankSectionContext(financials))
    : null;
  if (view === "fundamentals" && financials.taxEquivalent) {
    tables.push(exportEntriesTable("Tax-Equivalent Yield", taxEquivalentLines(financials.taxEquivalent)
      .map((line) => ({ label: line.label, value: line.value, formatted: line.text, unit: line.unit }))));
  }
  if (bank) tables.push(exportEntriesTable("Bank", bank.entries));
  if (view === "fundamentals") {
    const quote = financials.quote;
    const profile = financials.profile;
    tables.push(exportEntriesTable("Profile", [
      { label: "Symbol", value: quote?.symbol ?? financials.symbol },
      { label: "Name", value: quote?.name },
      { label: "Exchange", value: financials.exchange ? exchangeLabel(financials.exchange) : undefined },
      { label: "Sector", value: profile?.sector },
      { label: "Industry", value: profile?.industry },
      { label: "Description", value: profile?.description?.trim() },
      ...profile?.description?.trim() && profile.descriptionSource ? [
        { label: "Description Source", value: profile.descriptionSource.publisher },
        { label: "Description URL", value: profile.descriptionSource.url },
      ] : [],
    ].filter((entry) => typeof entry.value === "string" && entry.value.trim().length > 0)));
  }
  return {
    tables,
    footer: reportFooterLines({
      freshness,
      notes: [
        ...metrics.length === 0
          ? [`No ${view} reported for ${financials.symbol}.`]
          : fundamentalsNotes(atRegularSessionPrice(financials), metrics, financials.quote?.currency),
        ...fund ? [fund] : [],
        ...view === "fundamentals" ? statementFilingsNotes(financials.statementFilings) : [],
        ...bank?.notes ?? [],
        ...!bank && view === "fundamentals" && financials.bankNote ? [financials.bankNote] : [],
      ],
    }),
  };
}

/** "Euronext Paris (EPA)": the venue the report is for, named in full when the app knows it. */
function listingVenueLabel(
  listingExchange: string | undefined,
  quote: TickerFinancials["quote"],
  financials: TickerFinancials,
  tickerFile: TickerRecord | null,
): string {
  const exchangeName = quote?.exchangeName ?? financials.quoteMetadata?.listingExchangeName ?? tickerFile?.metadata.exchange;
  // A KOSDAQ code saved on KRX is reported from KOSDAQ, where its quote is read.
  const venue = canonicalExchange(quote?.tradingExchangeName || listingExchange || quote?.listingExchangeName || exchangeName);
  return isKnownExchangeCode(venue) ? exchangeLabel(venue) : exchangeShortName(exchangeName, quote?.fullExchangeName);
}

export async function buildTickerReport({
  symbol,
  listingExchange,
  tickerFile,
  financials,
  config,
  toBase,
  notes,
  quoteNote,
  listingNote,
  recentNews = [],
  recentSecFilings = [],
  hiddenSecFilings = NOTHING_HIDDEN,
  futuresContract = null,
  distributions = null,
  statementFilings = null,
  bondFund = null,
  memberships,
  offerings = [],
}: {
  symbol: string;
  /** The lists holding the company, by any of its listings (loadCompanyMemberships); the saved listing's own lists when absent. */
  memberships?: CompanyMemberships;
  /** The filings behind the latest statements, and a newer quarter's results release. */
  statementFilings?: StatementFilingsReport | null;
  /** The company's latest offering prospectuses (424B5, 424B4); those after the latest balance sheet get a note. */
  offerings?: readonly OfferingFiling[];
  /** A bond fund's SEC yield, yield to worst and duration (loadReportBondFacts). */
  bondFund?: FundBondFacts | null;
  /** The distributions a dividend yield is read with (loadDividendDistributions). */
  distributions?: DividendDistributions | null;
  /** The exchange the command named, as a canonical code. */
  listingExchange?: string;
  /** A futures symbol's contract terms and latest confirmed settlement. */
  futuresContract?: FuturesContractTermsPayload | null;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  toBase: ReportBaseConverter;
  notes?: string;
  /** Why there is no quote, when a source said; "Quote unavailable." otherwise. */
  quoteNote?: string;
  /** "CAR = Avis Budget Group, NASDAQ (also XETRA, ASX)", for a bare symbol several companies list. */
  listingNote?: string;
  recentNews?: NewsArticle[];
  recentSecFilings?: SecFilingItem[];
  /** What `recentSecFilings` left out. */
  hiddenSecFilings?: HiddenFilings;
}): Promise<string> {
  const quote = financials.quote;
  const fundamentals = financials.fundamentals;
  const priceReturns = computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory);
  const profile = financials.profile;
  const name = quote?.name || tickerFile?.metadata.name || symbol;
  const baseQuoteOptions = quoteFormatOptions(quote, tickerFile?.metadata.assetCategory, financials.quoteMetadata?.instrumentType);
  const baseCurrency = config.baseCurrency.trim().toUpperCase();
  const codes = writesCurrencyCodes(config);
  const rates: ReportRateNotes = {
    noted: new Set(),
    boughtAt: boughtRateCurrencies(tickerFile, quote?.currency?.trim() || tickerFile?.metadata.currency?.trim() || "", config.baseCurrency),
  };
  // Pad money prices to the currency's minor unit so a range reads £35.10 - £35.485, never past it (JPY has none).
  const quoteOptions = withCurrencyMinorDigits(codes ? { ...baseQuoteOptions, currencyCode: true } : baseQuoteOptions, quote?.currency);
  const lines: string[] = [];

  lines.push(`${cliStyles.accent(quote?.symbol ?? symbol)} ${cliStyles.bold(name)}`);
  if (!quote) lines.push(cliStyles.muted(quoteNote ?? QUOTE_UNAVAILABLE));

  const quoteCurrency = quote?.currency || financials.quoteMetadata?.currency || tickerFile?.metadata.currency;
  // An index's level is in points, as `history` heads its bars, not in the currency its members trade in.
  const indexLevel = isIndexLevel(quote?.instrumentType?.trim() || financials.quoteMetadata?.instrumentType?.trim() || tickerFile?.metadata.assetCategory);
  const summaryParts = [
    listingVenueLabel(listingExchange, quote, financials, tickerFile) || undefined,
    indexLevel ? INDEX_POINTS_LABEL : quoteCurrency ? `Currency ${currencyCodeLabel(quoteCurrency)}` : undefined,
    quoteMarketStateLabel(quote) ?? undefined,
    // A listing that no longer trades has no delay to speak of: its quote is its last session's close.
    quote?.dataSource && !quote.delisting ? `Source ${quote.dataSource.toUpperCase()}` : undefined,
  ].filter((part): part is string => !!part);
  if (summaryParts.length > 0) {
    lines.push(cliStyles.muted(summaryParts.join(METADATA_SEPARATOR)));
  }
  if (listingNote) lines.push(cliStyles.muted(listingNote));

  const instrumentType = instrumentTypeLabel(quote?.instrumentType?.trim()
    || financials.quoteMetadata?.instrumentType?.trim()
    || tickerFile?.metadata.assetCategory, name, { detail: true });
  const metadataParts = [
    instrumentType ? `Type ${instrumentType}` : undefined,
    (tickerFile?.metadata.sector || profile?.sector) ? `Sector ${tickerFile?.metadata.sector || profile?.sector}` : undefined,
    (tickerFile?.metadata.industry || profile?.industry) ? `Industry ${tickerFile?.metadata.industry || profile?.industry}` : undefined,
  ].filter((part): part is string => !!part);
  if (metadataParts.length > 0) {
    lines.push(cliStyles.muted(metadataParts.join(METADATA_SEPARATOR)));
  }

  // A list that holds the company as another of its listings says which: "Watchlists R (as RCI.B:TSX)".
  const lists = memberships ?? companyMemberships(config, tickerFile, [], null);
  const listNames = (held: readonly ListMembership[]) => held.map((list) => list.via ? `${list.name} (as ${list.via})` : list.name).join(", ");
  const membershipParts = [
    lists.portfolios.length > 0
      ? `Portfolios ${listNames(lists.portfolios)}`
      : undefined,
    lists.watchlists.length > 0
      ? `Watchlists ${listNames(lists.watchlists)}`
      : undefined,
  ].filter((part): part is string => !!part);
  if (membershipParts.length > 0) {
    lines.push(cliStyles.muted(membershipParts.join(METADATA_SEPARATOR)));
  }

  // Market cap and the multiples are measured at the regular session price the Quote section heads with.
  const priced = atRegularSessionPrice(financials);
  const capitalization = selectMarketCapitalization(priced.quote, priced.fundamentals);
  // Market cap and EV read in the currency they are reported in, as the revenue and income beside them do,
  // with the base currency's figure after them when it differs: 627.2B USD (878.15B CAD).
  const convertedCurrencies = new Set<string>();
  const inBase = async (value: number, currency: string): Promise<string> => {
    // A minor unit converts as the hundredth of its currency it is: 2.75T GBp is 27.5B GBP, never 2.75T GBP.
    const unit = heldCurrencyUnit(currency);
    if (!unit.currency || (unit.currency === baseCurrency && unit.divisor === 1)) return "";
    const major = value / unit.divisor;
    const converted = unit.currency === baseCurrency ? major : await toBase(major, unit.currency);
    if (!Number.isFinite(converted)) return "";
    if (unit.currency !== baseCurrency) convertedCurrencies.add(unit.currency);
    return ` (${formatCompact(converted)} ${baseCurrency})`;
  };
  const marketCapText = capitalization
    ? `${formatCompact(capitalization.value)} ${capitalization.currency}${await inBase(capitalization.value, capitalization.currency)}`
    : "—";
  // Shown in the same currency as the market cap, so the two can be compared.
  const enterpriseValue = reportedEnterpriseValue(priced.fundamentals);
  const evCurrency = enterpriseValueCurrency(quote, fundamentals);
  const enterpriseValueText = `${formatReportedMoney(enterpriseValue, evCurrency)}${enterpriseValue != null && evCurrency
    ? await inBase(enterpriseValue, evCurrency) : ""}`;

  if (quote) {
    // As the Overview reads it: the regular session, then the extended-hours print against its close.
    const session = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote);
    const extendedRow = (kind: "PRE" | "POST") => extended?.session === kind
      ? colorBySign(
        `${formatMarketPriceWithCurrency(extended.price, quote.currency, quoteOptions)} (${formatPercentRaw(extended.changePercent)})`,
        extended.change,
      )
      : "—";
    const volume = reportedQuoteVolume(quote);
    // A futures price is its latest trade; the exchange settlement is its own row, dated by its session.
    appendMetricSection(lines, "Quote", [
      // A price in cents says what it is per: 314.95¢/lb.
      ["Last", colorBySign(`${formatMarketPriceWithCurrency(session.price, quote.currency, quoteOptions)}${minorUnitPricePer(futuresContract, quote.currency)}`, session.change)],
      ...futuresContract
        ? [["Settle", quoteSettleText(quote, futuresContract)] as [string, string]]
        : [],
      // The move says what it is measured from: "vs Fri 16 Oct close", a future's "vs Fri 16 Oct settle".
      ["Change", quoteChangeText(quote, session, quoteOptions, futuresContract)],
      ["Open", quote.open != null ? formatMarketPriceWithCurrency(quote.open, quote.currency, quoteOptions) : "—"],
      // A listing that no longer trades: its last session's range, never today's.
      [quote.delisting ? "Last Session" : "Day Range", quote.low != null || quote.high != null
        ? formatPriceRange(quote.low, quote.high, quote.currency, quoteOptions)
        : "—"],
      ["52W Range", quote.low52w != null || quote.high52w != null
        ? formatPriceRange(quote.low52w, quote.high52w, quote.currency, quoteOptions)
        : "—"],
      ["Bid / Ask", bidAskText(quote, quoteOptions)],
      // An index's and a perpetual's 0 means none is counted, not no trades: no Volume row.
      ["Volume", volume != null ? formatNumber(volume, 0) : "—"],
      ["Updated", formatTimestamp(quoteHeadlineTime(quote))],
    ]);

    if (futuresContract) appendMetricSection(lines, "Contract", futuresContractMetrics(futuresContract, quote.symbol ?? symbol));

    appendMetricSection(lines, "Extended Hours", [
      [EXTENDED_SESSION_LABELS.PRE, extendedRow("PRE")],
      [EXTENDED_SESSION_LABELS.POST, extendedRow("POST")],
    ]);
  }

  const metrics = fundamentalsMetrics(quote, priced.fundamentals, profile, { text: marketCapText }, priceReturns, fundamentalsCurrency(financials),
    { text: enterpriseValueText }, distributions, bondFund, codes);
  const beforeFundamentals = lines.length;
  appendMetricSection(lines, "Fundamentals", metricLines(metrics));
  for (const note of fundamentalsNotes(priced, metrics, quote?.currency)) lines.push(cliStyles.muted(note));
  if (lines.length > beforeFundamentals) for (const note of conversionNotes(toBase, convertedCurrencies, rates)) lines.push(cliStyles.muted(note));
  // Where a fund's facts would go: under its fundamentals, or in their place.
  const fund = fundFactsNote(quote?.symbol ?? symbol,
    quote?.tradingExchangeName || listingExchange || quote?.listingExchangeName || quote?.exchangeName || tickerFile?.metadata.exchange, financials, tickerFile);
  if (fund) lines.push(...lines.length === beforeFundamentals ? [""] : [], cliStyles.muted(fund));

  if (capitalization?.provenance.kind === "fundamentals") {
    lines.push(cliStyles.muted(`Market cap: ${describeFundamentalMarketCap(capitalization.provenance)}.`));
  }

  const reportedCurrency = financials.financialCurrency?.trim();
  const statements = [...financials.annualStatements, ...financials.quarterlyStatements];
  const fallbackCurrency = reportedCurrency && statements.every((row) => !row.currency?.trim() || row.currency.trim() === reportedCurrency)
    ? reportedCurrency : undefined;
  const statementCurrency = (row: FinancialStatement) => row.currency?.trim() || fallbackCurrency;
  const latestAnnual = latestFinancialPeriod(financials.annualStatements, row => row.date);
  if (latestAnnual) {
    appendMetricSection(lines, `Latest Annual (${statementPeriodText(latestAnnual.date, statementFilings?.latestAnnual ?? null)})`,
      buildStatementMetrics(latestAnnual, statementCurrency(latestAnnual), codes));
  }

  const latestQuarter = latestFinancialPeriod(financials.quarterlyStatements, row => row.date);
  if (latestQuarter) {
    const runway = cashRunway(financials);
    appendMetricSection(lines, `Latest Quarter (${statementPeriodText(latestQuarter.date, statementFilings?.latestQuarter ?? null)})`,
      buildStatementMetrics(latestQuarter, statementCurrency(latestQuarter), codes, runway));
    // How the months are counted, and an offering since the balance sheet that the cash does not include yet.
    if (burnsCash(runway)) lines.push(cliStyles.muted(runwayMethod(runway.includesShortTerm)));
    const offering = runway ? offeringNote(offeringsAfter(offerings, runway.periodEnd), runway.periodEnd) : null;
    if (offering) lines.push(cliStyles.muted(offering));
  }
  // The statements stop a quarter short of the results the company has released.
  if (statementFilings?.resultsRelease && (latestAnnual || latestQuarter)) lines.push(cliStyles.muted(resultsReleaseText(statementFilings.resultsRelease)));

  appendDescription(lines, profile);

  appendTextSection(lines, "Notes", notes, true);

  appendFeedSection(lines, "Recent News", recentNews.map((item) => ({
    title: item.title,
    meta: [
      item.source,
      (() => {
        const publishedAt = parseDisplayDate(item.publishedAt as Date | string | number | undefined);
        return publishedAt ? formatTimestamp(publishedAt.getTime()) : "";
      })(),
    ],
    body: item.summary,
    link: item.url,
  })), recentNews[0]?.searchedFor ? coinNewsFallbackNotice(symbol, recentNews[0].searchedFor) : null);

  appendFeedSection(lines, "Recent SEC Filings", recentSecFilings.map((filing) => ({
    title: (() => {
      const filingDate = formatShortDate(filing.filingDate as Date | string | number | undefined, { fallback: "" });
      return filingDate ? `Form ${filing.form}${METADATA_SEPARATOR}${filingDate}` : `Form ${filing.form}`;
    })(),
    meta: [
      // The items by number and name, so a results 8-K reads apart from another 8-K filed the same day.
      filingItemsMeta(filing),
      getFilingDescription(filing) ?? "",
      filing.primaryDocument ? `Primary Document ${filing.primaryDocument}` : "",
    ],
    link: filing.filingUrl,
  })), hiddenFilingsNote(hiddenSecFilings));

  await appendTickerPositions(lines, tickerFile, quote, config, toBase, rates);

  return lines.join("\n");
}

function buildTickerStructuredData({
  symbol,
  listing,
  tickerFile,
  financials,
  config,
  notes,
  recentNews,
  recentSecFilings,
  hiddenSecFilings,
  futuresContract,
  distributions,
  statementFilings,
  bondFund = null,
  memberships,
  offerings = [],
}: {
  symbol: string;
  listing: CliListing;
  memberships: CompanyMemberships;
  statementFilings: StatementFilingsReport | null;
  offerings?: readonly OfferingFiling[];
  bondFund?: FundBondFacts | null;
  futuresContract: FuturesContractTermsPayload | null;
  distributions: DividendDistributions | null;
  tickerFile: TickerRecord | null;
  financials: TickerFinancials;
  config: AppConfig;
  notes: string;
  recentNews: NewsArticle[];
  recentSecFilings: SecFilingItem[];
  hiddenSecFilings: HiddenFilings;
}) {
  const quote = financials.quote;
  const priceReturns = computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory);
  const identity = listingIdentity(listing, quote);
  // Market cap and the multiples at the regular session price, as the text report gives them.
  const priced = atRegularSessionPrice(financials);
  const runway = cashRunway(financials);
  return {
    symbol,
    listing: { symbol: identity.symbol, exchange: identity.exchange || null, name: identity.name },
    quote: quote ? {
      symbol: quote.symbol,
      instrumentType: quote.instrumentType,
      name: quote.name,
      // Last and Change as the text report reads them, then the extended print from that close.
      ...getQuoteSessionFields(quote),
      // What Change is measured from ("vs Fri 16 Oct close"), and the quote's previous close with its exchange-local date.
      changeBasis: changeBasisJson(quoteChangeBasis(quote, { terms: futuresContract })),
      previousClose: quote.previousClose ?? null,
      previousCloseDate: quotePreviousCloseDate(quote),
      priceBasis: quote.priceBasis ?? null,
      currency: quote.currency,
      marketCap: priced.quote?.marketCap ?? null,
      volume: quote.volume ?? null,
      exchangeName: quote.exchangeName ?? "",
      fullExchangeName: quote.fullExchangeName ?? "",
      marketState: quote.marketState ?? "",
      dataSource: quote.dataSource ?? "",
      providerId: quote.providerId ?? "",
      lastUpdated: quote.lastUpdated ? new Date(quote.lastUpdated).toISOString() : "",
    } : null,
    quoteMetadata: financials.quoteMetadata,
    // Only for futures: the contract the symbol prices, its terms and its latest confirmed settlement.
    ...futuresContract ? { futuresContract } : {},
    ticker: tickerFile ? {
      ticker: tickerFile.metadata.ticker,
      name: tickerFile.metadata.name ?? "",
      exchange: tickerFile.metadata.exchange ?? "",
      assetCategory: tickerFile.metadata.assetCategory ?? "",
      sector: tickerFile.metadata.sector ?? "",
      industry: tickerFile.metadata.industry ?? "",
      portfolios: formatPortfolioNames(config, tickerFile.metadata.portfolios),
      watchlists: formatWatchlistNames(config, tickerFile.metadata.watchlists),
      positions: tickerFile.metadata.positions,
    } : null,
    // The lists holding the company by any of its listings; `via` names the other listing a list holds it as.
    memberships,
    fundamentals: financials.fundamentals || priceReturns.return1Y != null || priceReturns.return3Y != null ? exportedDividendFundamentals(exportedFundamentals({
      ...priced.fundamentals,
      ...priceReturns,
    })!, distributions) : undefined,
    // A bond fund's SEC yield, yield to worst and duration as its sponsor publishes them, each dated;
    // fundamentals.dividendYield is then its distribution yield, not its SEC yield.
    ...bondFund ? { bondFund } : {},
    profile: financials.profile,
    financialCurrency: financials.financialCurrency ?? null,
    latestAnnual: latestFinancialPeriod(financials.annualStatements, row => row.date) ?? null,
    latestQuarter: latestFinancialPeriod(financials.quarterlyStatements, row => row.date) ?? null,
    annualStatementCount: financials.annualStatements.length,
    quarterlyStatementCount: financials.quarterlyStatements.length,
    // Months of cash at the latest quarter's balance sheet, at its operating burn and the trailing year's,
    // and the offering prospectuses filed since that the cash does not include.
    cashRunway: runway,
    offeringsAfterBalanceSheet: runway ? offeringsAfter(offerings, runway.periodEnd) : [],
    // The form and filed date of the latest periods' filings, and a newer quarter's results released before its statements.
    statementFilings,
    notes,
    recentNews: recentNews.map((item) => ({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt instanceof Date ? item.publishedAt.toISOString() : item.publishedAt,
      url: item.url,
      summary: item.summary ?? "",
    })),
    recentSecFilings: recentSecFilings.map((filing) => ({
      form: filing.form,
      filingDate: filing.filingDate instanceof Date ? filing.filingDate.toISOString() : filing.filingDate,
      accessionNumber: filing.accessionNumber,
      filingUrl: filing.filingUrl,
      primaryDocumentUrl: filing.primaryDocumentUrl ?? "",
      description: getFilingDescription(filing) ?? "",
      items: secFilingItemCodes(filing.items) ?? "",
      // The items by number and name, as the text report shows them.
      itemsLabel: currentReportItemsLabel(filing.items) ?? "",
    })),
    // Left out of recentSecFilings unless --all: the pricing supplements a bank files for its notes,
    // and the 13D/13G the company filed as a holder of other companies.
    recentSecFilingsHidden: hiddenSecFilings,
  };
}

const QUOTE_UNAVAILABLE = "Quote unavailable.";

/** Asks for the quote the report lacks once more, for the reason the data service gave when it had none. */
async function quoteUnavailableNote(dataProvider: MarketContext["dataProvider"], symbol: string, exchange: string): Promise<string> {
  try {
    await dataProvider.getQuote(symbol, exchange);
  } catch (error) {
    return providerMissReason(error) ?? QUOTE_UNAVAILABLE;
  }
  return QUOTE_UNAVAILABLE;
}

export async function ticker(symbol: string, dependencies: TickerCommandDependencies = {}) {
  const initMarketDataFn = dependencies.initMarketData ?? initMarketData;
  const failCommand = dependencies.fail ?? fail;
  await withMarketData(initMarketDataFn, async ({ config, store, dataProvider, dataDir, statementSources }) => {
    let listing: CliListing;
    try {
      listing = await resolveCliListing(symbol, dependencies.exchange, { store, dataProvider });
    } catch (error) {
      if (error instanceof ListingArgError) failCommand(error.message, error.details);
      throw error;
    }
    // A named listing goes by its key (SAN:EPA); a bare symbol by its saved listing, as before.
    const normalized = listing.key;
    const tickerFile = listing.saved;
    const { symbol: requestSymbol, exchange } = listing.request;
    const toBase = createBaseConverter(dataProvider, config.baseCurrency);
    // A bare symbol's venues load beside its research, to name the company it was read as when several list it.
    const venues = loadBareVenues(listing, { store, dataProvider });
    // So does what became of the symbol, read from the research's quote as `history` reads it: a
    // company that moved (HFC became DINO), with nothing new listed there, has no profile of its own.
    const researchQuote = Promise.withResolvers<Quote | null>();
    const fate = listingFateLoader(listing, { dataProvider }, researchQuote.promise);
    const request: ListingDataRequest = { command: "ticker", noun: "research", fate };
    /** Nothing to show: a company that moved is under its new symbol. */
    const failIfMovedAway = async () => {
      researchQuote.resolve(null);
      const moved = movedAwayChange((await fate()).change);
      if (moved) failMovedSymbol(moved, request);
    };

    let financials: TickerFinancials | null = null;
    try {
      financials = await dataProvider.getTickerFinancials(requestSymbol, exchange);
    } catch (error) {
      // A known exchange the symbol is not listed on: say where it is.
      await failIfNotTraded(listing, { store, dataProvider }, { fail: failCommand });
      await failIfMovedAway();
      const reason = error instanceof Error ? error.message : String(error);
      // A symbol no listing carries is not a failed fetch, and the message already names it.
      if (isNotATickerMessage(reason)) failCommand(reason);
      failCommand(`Failed to fetch data for ${normalized}.`, reason);
    }

    const hasResearchData = financials && (
      financials.quote
      || Object.values(financials.profile ?? {}).some(value => value?.trim())
      || Object.entries(financials.fundamentals ?? {}).some(([key, value]) =>
        key !== "return1Y" && key !== "return3Y" && typeof value === "number" && Number.isFinite(value))
      || financials.quoteMetadata?.instrumentType?.trim()
      || financials.quoteMetadata?.currency?.trim()
      || financials.quoteMetadata?.listingExchangeName?.trim()
      || Object.values(computeTickerPriceReturns(financials, tickerFile?.metadata.assetCategory)).some(value => value != null)
      || financials.annualStatements.length > 0
      || financials.quarterlyStatements.length > 0
    );
    if (!financials || (!hasResearchData && !tickerFile?.metadata.positions.some((position) => position.shares !== 0))) {
      await failIfNotTraded(listing, { store, dataProvider }, { fail: failCommand });
      await failIfMovedAway();
      failCommand(`No research data available for ${normalized}.`);
    }
    const resolvedFinancials = financials as TickerFinancials;
    const quote = resolvedFinancials.quote;
    // The quote is the old line's (stopped, or named for the company that left): the profile and figures are another security's.
    researchQuote.resolve(quote ?? null);
    const { moved } = await fate();
    if (moved) failMovedSymbol(moved, request);

    const notesFiles = new NotesFiles(dataDir);
    const listingName = listingIdentity(listing, quote).name;
    // The yield's distributions, read beside the rest when a trailing yield, a forward basis or its lapse needs them; they never fail the report.
    const distributions = loadDividendDistributions(dataProvider, { symbol: requestSymbol, exchange }, resolvedFinancials,
      { declared: !dependencies.printResult });
    // A bond fund's SEC yield, yield to worst and duration, beside its distribution yield.
    const bondFund = loadReportBondFacts(requestSymbol,
      quote?.tradingExchangeName || exchange || quote?.listingExchangeName || quote?.exchangeName || tickerFile?.metadata.exchange,
      resolvedFinancials, tickerFile);
    const statementFilings = loadStatementFilings(statementSources, { symbol: requestSymbol, exchange }, {
      quarter: latestFinancialPeriod(resolvedFinancials.quarterlyStatements, (row) => row.date),
      annual: latestFinancialPeriod(resolvedFinancials.annualStatements, (row) => row.date),
    });
    // A list holding the company as another of its listings counts (a list of RCI.B:TSX holds RCI); read beside the rest. It never fails.
    const membershipsLoad = loadCompanyMemberships({
      config,
      own: tickerFile,
      symbol: listing.symbol,
      exchange: canonicalExchange(listing.exchange || quote?.listingExchangeName || quote?.exchangeName || tickerFile?.metadata.exchange),
      loadTickers: () => store.loadAllTickers(),
      dataProvider,
    });
    // An offering since the latest balance sheet, read only when the report has a runway to flag.
    const offerings = loadOfferingFilings(statementSources, { symbol: requestSymbol, exchange }, cashRunway(resolvedFinancials) != null);
    const [notesResult, newsResult, secFilingsResult] = await Promise.allSettled([
      notesFiles.load(tickerFile?.metadata.ticker ?? normalized),
      dataProvider.getNews({
        feed: "ticker",
        // Still set for news plugins that read the deprecated scope.
        scope: "ticker",
        ticker: requestSymbol,
        exchange: exchange || quote?.exchangeName || "",
        tickerTier: "primary",
        limit: NEWS_ITEM_LIMIT,
        // A coin pair with no story filed under it searches for the coin by this name.
        ...(isRoundTheClockCoin(requestSymbol, exchange || quote?.exchangeName) && (quote?.name || tickerFile?.metadata.name)
          ? { listingName: quote?.name || tickerFile?.metadata.name }
          : {}),
      }),
      // Outside the US the lookup checks the SEC registrant against the listing's company,
      // and refuses another company's filings.
      shouldFetchSecFilings(requestSymbol, exchange, tickerFile, resolvedFinancials) && dataProvider.getSecFilings
        ? loadRecentSecFilings((count) => dataProvider.getSecFilings!(requestSymbol, count, exchange || quote?.exchangeName || "",
          listingName ? { listingName } : undefined), dependencies.allFilings === true)
        : Promise.resolve({ filings: [], hidden: NOTHING_HIDDEN }),
    ]);

    const futuresContract = await cliFuturesContract(quote?.symbol ?? requestSymbol, quote?.instrumentType, dependencies.futuresContract);
    const notes = notesResult.status === "fulfilled" ? notesResult.value : "";
    const recentNews = newsResult.status === "fulfilled" ? newsResult.value : [];
    const { filings: recentSecFilings, hidden: hiddenSecFilings } = secFilingsResult.status === "fulfilled"
      ? secFilingsResult.value : { filings: [], hidden: NOTHING_HIDDEN };

    // The quote is the feed in this report; without one, the fundamentals date it.
    const freshness = quote ? quotesFreshness([quote]) : fundamentalsFreshness(resolvedFinancials);
    const quoteNote = quote ? undefined : await quoteUnavailableNote(dataProvider, requestSymbol, exchange);
    const [choiceNote] = await listingChoiceNotes(listing, { store, dataProvider }, quote, venues);
    // A bare coin ticker read as a fund says where the coin is, as `quote` does; a named listing was meant.
    const coinNote = listing.exchange ? null
      : notTheCoinNote(listing.symbol, quote ?? (tickerFile ? { name: tickerFile.metadata.name, instrumentType: tickerFile.metadata.assetCategory } : null));
    const listingNote = [choiceNote, coinNote].filter((note): note is string => !!note).join("\n") || undefined;
    const memberships = await membershipsLoad;
    if (dependencies.printResult) {
      const newsNote = recentNews[0]?.searchedFor ? coinNewsFallbackNotice(requestSymbol, recentNews[0].searchedFor) : null;
      const warnings = [choiceNote, coinNote, quoteNote, newsNote].filter((note): note is string => !!note);
      dependencies.printResult({
        freshness,
        warnings: warnings.length > 0 ? warnings : undefined,
        data: buildTickerStructuredData({
          symbol: normalized,
          listing,
          tickerFile,
          financials: resolvedFinancials,
          config,
          notes,
          recentNews,
          recentSecFilings,
          hiddenSecFilings,
          futuresContract,
          distributions: await distributions,
          statementFilings: await statementFilings,
          bondFund: await bondFund,
          memberships,
          offerings: await offerings,
        }),
      });
      return;
    }

    console.log(await buildTickerReport({
        symbol: normalized,
        listingExchange: listing.exchange,
        tickerFile,
        financials: resolvedFinancials,
        config,
        toBase,
        notes,
        quoteNote,
        listingNote,
        recentNews,
        recentSecFilings,
        hiddenSecFilings,
        futuresContract,
        distributions: await distributions,
        statementFilings: await statementFilings,
        bondFund: await bondFund,
        memberships,
        offerings: await offerings,
    }));
    if (freshness) console.log(`\n${cliFreshnessFooter(freshness)}`);
  });
}
