import { logFailure } from "../../../../utils/log-failure";
import { createBaseConverter, type BaseConversion } from "../../../../cli/base-converter";
import { quotedFxPair } from "../../../../utils/currency-pair";
import { formatFxRate } from "../../../../cli/fx-pair";
import { savedListingName } from "../../../../cli/listing-arg";
import { currentListingName } from "../../../../tickers/listing-name";
import { withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers } from "../../../../cli/helpers";
import {
  cliStyles,
  colorBySign,
  renderSection,
  renderTable,
} from "../../../../utils/cli-output";
import { formatCompact, formatPercentRaw } from "../../../../utils/format";
import { currencyPriceMinDigits, formatMarketCostWithCurrency, formatMarketPrice, formatMarketPriceWithCurrency, formatMarketQuantity, quoteFormatOptions } from "../../../../market-data/market/format";
import { resolvePriceBasis } from "../../../../market-data/market/price-basis";
import { combinedChangeBasisLabel, quoteChangeBasis, type QuoteChangeBasis } from "../../../../market-data/market/change-basis";
import { getPortfolioPositionMetrics, lotCostAtTodaysRate, lotCostFxRate, resolvePortfolioMarketValue, resolvePortfolioPositionPnl } from "../../../../portfolio/position-metrics";
import {
  getPortfolioValuationDisplay,
  getPortfolioValuationTime,
  valuationBasisLabel,
  valuationTimeIso,
  valuesAtSettlement,
  type PortfolioValuationBasis,
} from "../../../../portfolio/valuation-basis";
import {
  futuresQuantityText,
  futuresSettlementDisplay,
  isFuturesTicker,
  withFuturesContractSize,
  type PortfolioFuturesTerms,
} from "../../../../portfolio/futures-positions";
import { dailyFuturesHistory, loadPortfolioFuturesTerms, type PortfolioFuturesSources } from "../../../../portfolio/futures-terms";
import { loadPurchaseDateCostFx, withPurchaseDateCostFx, type CostFxHistoryClient, type PurchaseDateCostFx } from "../../../../portfolio/cost-fx";
import { apiClient } from "../../../../api-client";
import { formatUtcDayTime, parseReportTime } from "../../../../utils/utc-time";
import { quoteFreshnessFields } from "../../shared/report-freshness";
import { resolvePortfolioTotalsCurrency } from "../summary/totals";
import {
  EXTENDED_SESSION_LABELS,
  exchangeShortName,
  getActiveQuoteDisplay,
  getExtendedSessionDisplay,
  quoteHeadlineTime,
  type ActiveQuoteDisplay,
  type ExtendedSession,
  type ExtendedSessionDisplay,
} from "../../../../market-data/market/status";
import { formatPerpetualRate, headlineQuoteDisplay } from "../../../../portfolio/column-values";
import type { AppConfig } from "../../../../types/config";
import type { DataProvider } from "../../../../types/data-provider";
import type { CliCommandContext } from "../../../../types/plugin";
import type { MarketContext } from "../../../../cli/types";
import type { Portfolio, TickerPosition, TickerRecord } from "../../../../types/ticker";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerInstrumentKind } from "../../../../types/instrument";
import { resolveTickerInstrumentKind } from "../../../../tickers/instrument-kind";
import { perpetualListing } from "../../../../tickers/perpetual-listing";
import { loadPerpetualMarket } from "../../../../sources/gloomberb-cloud/perpetuals";
import { listedMarketCapitalization, selectMarketCapitalization } from "../../../../utils/market-capitalization";
import { chunked, mapWithConcurrency } from "../../../../utils/concurrency";
import { liveMarketCapitalization } from "../../../../market-data/quotes/live-valuation";
import { delistingLabel } from "../../../../market-data/quotes/delisting";
import { instrumentFromTicker } from "../../../../market-data/request-types";
import { toMarketDataContext } from "../../../../market-data/selectors";
import { cliFreshnessFooter } from "../../../../cli/result";
import { renderReportGlossary, reportGlossary, type GlossaryEntry } from "../../../../cli/glossary";
import { quotesFreshness, rowsFreshness } from "../../../../cli/freshness";
import type { BrokerAccount } from "../../../../types/trading";
import {
  BROKER_ACCOUNT_MISSING_NOTE,
  CASH_SYMBOL,
  buildPortfolioAllocation,
  describeTargetSum,
  formatAllocationDrift,
  formatAllocationMoney,
  formatAllocationWeight,
  formatTradeUnits,
  hasTargetWeights,
  lotWeight,
  resolvePortfolioCash,
  weightBasisNote,
  type AllocationHolding,
  type PortfolioAllocation,
} from "../../../../portfolio/allocation";
import { findCachedPortfolioAccount } from "../cached-account";
import { importedFromText } from "../imported-from";
import { findNamedCollection } from "../../../../portfolio/collection-name";
import { isoDateToday } from "../../../../utils/calendar-date";
import { lastTradeDate } from "../../../../tickers/listing-fate";
import { DIVIDEND_READ_DEADLINE_MS, incomeGapNote, loadHoldingDividends, portfolioIncome, projectDrip, showsIncomeColumns, type DripYear, type HoldingDividend } from "../income";

/** Money prices pad to the currency's minor unit ($337.90, not $337.9), as the ticker view does. */
function priceFormatOptions(quote: Parameters<typeof quoteFormatOptions>[0] & { currency?: string }, assetCategory?: string) {
  const options = quoteFormatOptions(quote, assetCategory);
  return resolvePriceBasis(options.priceBasis, options.assetCategory) === "per-unit"
    ? { ...options, minimumFractionDigits: currencyPriceMinDigits(quote?.currency) }
    : options;
}

/** A Last as `quote` prints it: money in the quote's currency, and an index level in points, padded to two decimals. */
function formatListPrice(value: number, quote: Parameters<typeof quoteFormatOptions>[0] & { currency: string }, assetCategory?: string): string {
  const options = priceFormatOptions(quote, assetCategory);
  return options.assetCategory?.trim().toUpperCase() === "INDEX"
    ? formatMarketPrice(value, { ...options, minimumFractionDigits: 2 })
    : formatMarketPriceWithCurrency(value, quote.currency, options);
}

/**
 * What a collection's Last and Chg show, as the PF and watchlist panes do: the
 * traded price until the regular close, then that close and its move, with a
 * pre-market or after-hours print beside them, measured from that close.
 * Market value and P&L keep the latest print unless the book is valued at the
 * regular close (`portfolio show --close`), which is this Last.
 */
export function collectionQuoteHeadline(quote: CollectionQuote | undefined): {
  headline: ActiveQuoteDisplay | null;
  extended: ExtendedSessionDisplay | null;
} {
  const traded = getActiveQuoteDisplay(quote);
  const headline = traded && Number.isFinite(traded.price) ? headlineQuoteDisplay(traded, quote) : null;
  const extended = headline ? getExtendedSessionDisplay(quote) : null;
  return { headline, extended: extended && Number.isFinite(extended.price) ? extended : null };
}

/** The extended print as export fields: all null without one. */
export function extendedQuoteFields(extended: ExtendedSessionDisplay | null) {
  return {
    extendedSession: extended?.session ?? null,
    extendedPrice: extended?.price ?? null,
    extendedChange: extended?.change ?? null,
    extendedChangePercent: extended?.changePercent ?? null,
  };
}

/**
 * The listing a row is (SAN:EPA, as the Ticker column names it) and its company, as export fields:
 * the name its quote gives now, as `quote` names it, else the one it was saved with.
 */
function listingColumns(ticker: TickerRecord, quote: CollectionQuote | undefined) {
  return { listing: listingLabel(ticker), name: currentListingName(ticker, quote) };
}

/** The Chg column's move as export fields: from the close the headline price is measured against. */
function quoteMoveColumns(headline: ActiveQuoteDisplay | null) {
  const known = (value: number | undefined) => value != null && Number.isFinite(value) ? value : null;
  return { quoteChange: known(headline?.change), quoteChangePercent: known(headline?.changePercent) };
}

/** The extended sessions among the rows' prints, in the order their columns go. */
export function extendedSessionsOf(sessions: Iterable<ExtendedSession | null | undefined>): ExtendedSession[] {
  const present = new Set(sessions);
  return (["PRE", "POST", "OVERNIGHT"] as const).filter((session) => present.has(session));
}

export function renderCollectionOverview(config: AppConfig, tickers: TickerRecord[]): string {
  const blocks: string[] = [];

  blocks.push(renderSection("Portfolios"));
  if (config.portfolios.length === 0) {
    blocks.push(cliStyles.muted("No portfolios configured."));
  } else {
    blocks.push(renderTable(
      [
        { header: "Portfolio" },
        { header: "Currency" },
        { header: "Tickers", align: "right" },
      ],
      config.portfolios.map((portfolio) => [
        portfolio.name,
        resolvePortfolioTotalsCurrency(portfolio, config.baseCurrency),
        String(countCollectionTickers(tickers, "portfolios", portfolio.id)),
      ]),
    ));
  }

  blocks.push("");
  blocks.push(renderSection("Watchlists"));
  if (config.watchlists.length === 0) {
    blocks.push(cliStyles.muted("No watchlists configured."));
  } else {
    blocks.push(renderTable(
      [
        { header: "Watchlist" },
        { header: "Tickers", align: "right" },
      ],
      config.watchlists.map((watchlist) => [
        watchlist.name,
        String(countCollectionTickers(tickers, "watchlists", watchlist.id)),
      ]),
    ));
  }

  return blocks.join("\n");
}

export interface ShowCollectionOptions {
  /** `--explain`: follow the report with what the terms it shows mean, as `fn <function> --explain` does. */
  explain?: boolean;
  /** What a portfolio's value is priced at; the latest print when absent. */
  basis?: PortfolioValuationBasis;
  /** `--drip`: project reinvested dividends this many years, with this percent withheld from each. */
  drip?: { years: number; withholding: number };
  /** How long every holding's dividend read may take together; a test shortens it. */
  dividendDeadlineMs?: number;
  /** Where futures' terms and settlements are read; Gloom Cloud's terms and the data provider's daily bars by default. */
  futuresSources?: PortfolioFuturesSources;
  /** Where the FX closes of the lots' purchase dates are read; Gloom Cloud by default. */
  costFxHistory?: CostFxHistoryClient;
}

export async function showCollection(name: string, ctx: CliCommandContext, options: ShowCollectionOptions = {}) {
  await withMarketData(ctx, (context) => showCollectionWithMarketData(name, ctx, context, options));
}

/** What `--explain` names a report by when it shows no terms. */
const EXPLAINED_REPORT = "This report";

/** The terms as `--json` lists them, in the shape `fn --explain` gives `data.glossary`. */
function glossaryExport(entries: readonly GlossaryEntry[]) {
  return entries.map(({ term, short, definition }) => ({ term, ...(short ? { short } : {}), definition }));
}

/** A portfolio or watchlist named by its id or its name, either in any case. */
export type CollectionMatch =
  | { kind: "portfolio"; id: string; name: string; portfolio: Portfolio }
  | { kind: "watchlist"; id: string; name: string };

export function findCollection(config: AppConfig, name: string): CollectionMatch | null {
  const portfolio = findNamedCollection(config.portfolios, name);
  if (portfolio) return { kind: "portfolio", id: portfolio.id, name: portfolio.name, portfolio };
  const watchlist = findNamedCollection(config.watchlists, name);
  return watchlist ? { kind: "watchlist", id: watchlist.id, name: watchlist.name } : null;
}

type CollectionQuote = Awaited<ReturnType<DataProvider["getQuote"]>>;

/**
 * Current quotes for a collection's tickers, keyed by symbol. A portfolio
 * quotes each holding's own contract; a failed quote leaves its ticker out so
 * the rest still values.
 */
export async function loadCollectionQuotes(
  tickers: readonly TickerRecord[],
  collection: Pick<CollectionMatch, "kind" | "id">,
  dataProvider: Pick<DataProvider, "getQuote">,
  /** The report prints what the day's move is from (`Day's move ... vs Thu 22 Oct close`). */
  { datesChangeBasis = false }: { datesChangeBasis?: boolean } = {},
): Promise<Map<string, CollectionQuote>> {
  const isPortfolio = collection.kind === "portfolio";
  const quotes = new Map<string, CollectionQuote>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const instrument = isPortfolio ? instrumentFromTicker(ticker, ticker.metadata.ticker, { portfolioId: collection.id }) : null;
        if (isPortfolio && !instrument) return;
        const context = instrument ? toMarketDataContext(instrument) : undefined;
        const quote = await dataProvider.getQuote(ticker.metadata.ticker, ticker.metadata.exchange,
          datesChangeBasis ? { ...context, datesChangeBasis } : context);
        quotes.set(ticker.metadata.ticker, quote);
      } catch (error) {
        // A partial quote failure leaves the rest of the table rendering.
        logFailure("portfolio-list.cli.render", "Load collection quote failed")(error);
      }
    }),
  );
  return quotes;
}

/** One ticker of a portfolio: a valued position, or the ticker alone when it holds none. */
interface PortfolioPositionValue {
  ticker: TickerRecord;
  quote: CollectionQuote | undefined;
  /** The live print, extended hours included. */
  activeQuote: ReturnType<typeof getActiveQuoteDisplay> | null;
  /** Last and Chg as shown: the regular session's (collectionQuoteHeadline). */
  headline: ActiveQuoteDisplay | null;
  /** A pre-market or after-hours print, from the close in `headline`. */
  extended: ExtendedSessionDisplay | null;
  /** Null for a ticker kept in the portfolio without an open position. */
  position: TickerPosition | null;
  metrics: ReturnType<typeof getPortfolioPositionMetrics> | null;
  /** Unrealized P&L in the portfolio's currency. */
  pnl: number | null;
  /** The price the position is valued at, on the valuation's basis, and when it is from. */
  valuation: PortfolioValuationFields;
  /**
   * The position's move over the day of that price, in the portfolio's
   * currency, and its value at the close before; null when either is unknown.
   */
  dayMove: { change: number; previousValue: number } | null;
  /** The `portfolio show --json` row. */
  row: Record<string, unknown>;
  /** A future's contract size and settlement from its terms; null for any other holding. */
  futures: PortfolioFuturesTerms | null;
  /**
   * Only on a lot held in another currency than the portfolio's: the rate its
   * cost converted at (one unit of its currency in the portfolio's, when
   * bought), or null when it converted at today's rate.
   */
  costFx?: { rate: number; currency: string } | null;
}

/** What a row's value is priced at: exported after every other field, so existing columns keep their places. */
interface PortfolioValuationFields {
  valuationBasis: PortfolioValuationBasis;
  /** In the quote's currency. */
  valuationPrice: number | null;
  /** An ISO instant in UTC, or an ISO date for a close whose hour the venue's calendar does not give. */
  valuationAsOf: string | null;
  /** Only on a future valued at its exchange settlement, which `valuationAsOf` dates by its session. */
  valuationPriceKind?: "settle";
}

export interface PortfolioValuation {
  basis: PortfolioValuationBasis;
  positions: PortfolioPositionValue[];
  /** One per ticker, for weights and targets. */
  holdings: AllocationHolding[];
  totalPnl: number;
  unavailablePnl: Set<string>;
  unavailableCost: Set<string>;
  unavailableMarketValue: Set<string>;
  brokerPnlSymbols: Set<string>;
  /** Futures held without a contract size: no value, cost or P&L, said once instead of as each. */
  unknownContractSize: Set<string>;
  /** Futures valued at the close without a confirmed settlement to value them at. */
  unsettled: Set<string>;
  /**
   * Holdings in another currency whose cost converts at today's rate: no
   * purchase date or cost FX rate was entered (`costFxUndated`), or the
   * date's FX close could not be read (`costFxUnread`).
   */
  costAtTodaysRate: Set<string>;
  costFxUndated: Set<string>;
  costFxUnread: Set<string>;
  /** Long and short market value of the priced lots, and their net and gross, in the portfolio's currency. */
  exposure: PortfolioExposure;
}

/** A book's exposure: what its longs and its shorts are worth (short negative), net and gross. */
export interface PortfolioExposure {
  long: number;
  short: number;
  net: number;
  gross: number;
}

/** The exposure of lots at their signed market values; an unpriced lot (null) is left out, as the total leaves it. */
function portfolioExposure(values: Iterable<number | null | undefined>): PortfolioExposure {
  let long = 0;
  let short = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    if (value >= 0) long += value;
    else short += value;
  }
  return { long, short, net: long + short, gross: long - short };
}

/**
 * What a book says of holdings in another currency whose cost converts at
 * today's rate, which leaves the currency's move since purchase out of their
 * P&L: those with no purchase date or rate, and those whose date's FX close
 * could not be read. `named` lists them as the table names its rows.
 */
export function costAtTodaysRateNotes(valuation: Pick<PortfolioValuation, "costFxUndated" | "costFxUnread">,
  named: (symbols: Iterable<string>) => string): string[] {
  const undated = valuation.costFxUndated;
  return [
    ...undated.size ? [`Cost converted at today's rate for ${named(undated)}; give portfolio position set a --date or --cost-fx to use the rate when bought.`] : [],
    ...valuation.costFxUnread.size ? [`Cost converted at today's rate for ${named(valuation.costFxUnread)}: the FX close of the purchase date could not be read.`] : [],
  ];
}

/**
 * Values every position of a portfolio in the portfolio's currency, as
 * `portfolio show` prints it: cost basis, market value and unrealized P&L
 * from the current quote at `basis` (the latest print unless given), or the
 * broker's snapshot where that is the basis. A future counts contracts of the
 * size `futures` gives for it, and at the close is valued at its settlement.
 */
export async function valuePortfolioPositions({
  tickers,
  quotes,
  portfolioId,
  currency,
  baseCurrency,
  toBase,
  basis = "latest-print",
  futures,
  purchaseDateFx,
}: {
  tickers: readonly TickerRecord[];
  quotes: ReadonlyMap<string, CollectionQuote>;
  portfolioId: string;
  currency: string;
  baseCurrency: string;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
  basis?: PortfolioValuationBasis;
  /** Each future's contract size and settlement (loadPortfolioFuturesTerms), by symbol. */
  futures?: ReadonlyMap<string, PortfolioFuturesTerms>;
  /**
   * The FX closes of the lots' purchase dates in `currency` (loadPurchaseDateCostFx): a dated lot with no rate of
   * its own into `currency` converts its cost at its date's close, and at today's rate when that could not be read.
   */
  purchaseDateFx?: PurchaseDateCostFx;
}): Promise<PortfolioValuation> {
  const id = portfolioId;
  let totalPnl = 0;
  const unavailablePnl = new Set<string>();
  const unavailableCost = new Set<string>();
  const unavailableMarketValue = new Set<string>();
  const brokerPnlSymbols = new Set<string>();
  const unknownContractSize = new Set<string>();
  const unsettled = new Set<string>();
  const costAtTodaysRate = new Set<string>();
  const costFxUndated = new Set<string>();
  const costFxUnread = new Set<string>();
  const values: PortfolioPositionValue[] = [];
  const holdings: AllocationHolding[] = [];
  const known = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;

  for (const ticker of purchaseDateFx ? withPurchaseDateCostFx(tickers, purchaseDateFx, currency, id) : tickers) {
    const quote = quotes.get(ticker.metadata.ticker);
    const futuresTerms = isFuturesTicker(ticker) ? futures?.get(ticker.metadata.ticker) ?? { size: null, settlement: null } : null;
    // A lot entered without its contract size takes the one the terms state; the entries keep the saved record.
    const sized = withFuturesContractSize(ticker, futuresTerms?.size);
    const positions = sized.metadata.positions.filter((position) => position.portfolio === id && position.shares !== 0);
    const displayedQuote = getActiveQuoteDisplay(quote);
    const activeQuote = displayedQuote && Number.isFinite(displayedQuote.price) ? displayedQuote : null;
    // At the close a future's Last is the settlement it is valued at, and its move the one from the settlement before.
    const settledHeadline = basis === "regular-close" && futuresTerms?.settlement ? futuresSettlementDisplay(futuresTerms.settlement) : null;
    const { headline, extended } = settledHeadline ? { headline: settledHeadline, extended: null } : collectionQuoteHeadline(quote);

    if (positions.length === 0) {
      const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
      // What a holding would be priced at, for the trade that reaches its target.
      const priced = basis === "regular-close" ? headline : activeQuote;
      const unitPrice = priced ? known(await toBase(priced.price, quoteCurrency)) : null;
      holdings.push({ symbol: ticker.metadata.ticker, held: false, marketValue: 0, units: 0, unitPrice });
      values.push({ ticker, quote, activeQuote, headline, extended, position: null, metrics: null, pnl: null, dayMove: null, futures: futuresTerms,
        valuation: { valuationBasis: basis, valuationPrice: known(priced?.price),
          valuationAsOf: settledHeadline ? futuresTerms!.settlement!.date : valuationTimeIso(getPortfolioValuationTime(quote, basis)),
          ...(settledHeadline ? { valuationPriceKind: "settle" as const } : {}) },
        row: { symbol: ticker.metadata.ticker, ...listingColumns(ticker, quote), exchange: ticker.metadata.exchange, shares: null, avgCost: null,
          positionCurrency: null, quotePrice: known(headline?.price), ...quoteMoveColumns(headline), ...extendedQuoteFields(extended), quoteCurrency: quote?.currency ?? null,
          volume: known(quote?.volume), costBasis: null, marketValue: null, unrealizedPnl: null, baseCurrency: currency } });
      continue;
    }

    const holding: AllocationHolding = { symbol: ticker.metadata.ticker, held: true, marketValue: 0, units: 0, unitPrice: null };
    holdings.push(holding);
    for (const position of positions) {
      const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
      const metrics = getPortfolioPositionMetrics({ ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, id, quoteCurrency, undefined, quote);
      const settlement = futuresTerms?.settlement ?? null;
      const valuationQuote = getPortfolioValuationDisplay(metrics, quote, basis, settlement);
      const atSettlement = valuesAtSettlement(metrics, basis);
      const positionCurrency = metrics.positionCurrency;
      const positionRate = positionCurrency ? await toBase(1, positionCurrency) : Number.NaN;
      // The cost converts at the rate the lot was bought at, entered or its purchase date's close, else at today's, as its value does.
      const baseMetrics = getPortfolioPositionMetrics({ ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, id, quoteCurrency,
        { currency, convert: value => value * positionRate }, quote);
      const boughtRate = positionCurrency ? lotCostFxRate(position, positionCurrency, currency) : null;
      const costBasisBase = !positionCurrency ? Number.NaN
        : boughtRate !== null ? baseMetrics.totalCost : await toBase(metrics.totalCost, positionCurrency);
      // Only a lot entered by hand can be given the rate it was bought at; a broker's lot reads as it always has.
      const atTodaysRate = position.broker === "manual" && !!positionCurrency && lotCostAtTodaysRate(position, positionCurrency, currency);
      if (atTodaysRate && metrics.hasCostBasis) {
        costAtTodaysRate.add(ticker.metadata.ticker);
        (purchaseDateFx && position.dateAcquired ? costFxUnread : costFxUndated).add(ticker.metadata.ticker);
      }
      const costFx = boughtRate !== null ? { rate: boughtRate, currency } : atTodaysRate ? null : undefined;
      const currentValueBase = resolvePortfolioMarketValue(baseMetrics,
        valuationQuote ? await toBase(valuationQuote.price, quoteCurrency) : null)?.gross ?? null;
      const selectedPnl = resolvePortfolioPositionPnl(baseMetrics,
        valuationQuote ? await toBase(valuationQuote.price, quoteCurrency) : null);
      const pnl = selectedPnl.value;
      if (metrics.unknownContractSize) unknownContractSize.add(ticker.metadata.ticker);
      else if (atSettlement && !settlement) unsettled.add(ticker.metadata.ticker);
      if (!metrics.hasCostBasis) unavailableCost.add(ticker.metadata.ticker);
      if (known(currentValueBase) === null) unavailableMarketValue.add(ticker.metadata.ticker);
      if (selectedPnl.basis === "broker-snapshot" || selectedPnl.basis === "mixed") brokerPnlSymbols.add(ticker.metadata.ticker);
      if (pnl != null && Number.isFinite(pnl)) totalPnl += pnl;
      else unavailablePnl.add(ticker.metadata.ticker);
      const direction = metrics.totalShares < 0 ? -1 : 1;
      const marketValue = currentValueBase == null ? null : known(direction * currentValueBase);
      holding.marketValue = holding.marketValue == null || marketValue == null ? null : holding.marketValue + marketValue;
      holding.units += metrics.totalShares;
      holding.unitPrice ??= valuationQuote ? known(await toBase(valuationQuote.price, quoteCurrency)) : null;
      const change = valuationQuote?.change;
      const dayMove = valuationQuote && change != null && Number.isFinite(change)
        ? { change: await toBase(metrics.totalPriceUnits * change, quoteCurrency),
          previousValue: await toBase(metrics.grossPriceUnits * (valuationQuote.price - change), quoteCurrency) }
        : null;
      values.push({ ticker, quote, activeQuote, headline, extended, position, metrics, pnl, futures: futuresTerms, ...(costFx !== undefined ? { costFx } : {}),
        dayMove: dayMove && Number.isFinite(dayMove.change) && Number.isFinite(dayMove.previousValue) ? dayMove : null,
        valuation: { valuationBasis: basis, valuationPrice: known(valuationQuote?.price),
          valuationAsOf: valuationTimeIso(getPortfolioValuationTime(quote, basis, metrics, settlement)),
          ...(atSettlement && settlement ? { valuationPriceKind: "settle" as const } : {}) },
        row: { symbol: ticker.metadata.ticker, ...listingColumns(ticker, quote), exchange: ticker.metadata.exchange,
          shares: metrics.totalShares, avgCost: known(position.avgCost), positionCurrency,
          priceBasis: position.priceBasis ?? null, quantityUnit: metrics.priceBasis === "percent-of-par" ? "face" : null, quotePriceBasis: quote?.priceBasis ?? null,
          // Last as shown, the regular close after it; market value and P&L are at `valuationPrice`.
          quotePrice: known(headline?.price), ...quoteMoveColumns(headline), ...extendedQuoteFields(extended), quoteCurrency,
          volume: known(quote?.volume), quoteAsOf: quote ? quoteHeadlineTime(quote) : null,
          costBasis: known(direction * costBasisBase), marketValue,
          unrealizedPnl: known(pnl), baseCurrency: currency, dateAcquired: position.dateAcquired ?? null,
          pnlBasis: selectedPnl.basis, brokerUnrealizedPnl: known(position.unrealizedPnl), brokerPnlCurrency: positionCurrency, brokerPnlAsOf: null } });
    }
  }

  const exposure = portfolioExposure(values.map((entry) => entry.position ? entry.row.marketValue as number | null : null));
  return { basis, positions: values, holdings, totalPnl, unavailablePnl, unavailableCost, unavailableMarketValue, brokerPnlSymbols,
    unknownContractSize, unsettled, costAtTodaysRate, costFxUndated, costFxUnread, exposure };
}

/**
 * The holdings' move over the day of the prices they are valued at, in the
 * portfolio's currency, and that move against their value at the close
 * before, with what it is measured from as the pane's Day says it ("vs Fri 16
 * Oct close", "vs mixed closes"). Null when any priced holding's move is
 * unknown, as the pane's Day is.
 */
export function portfolioDayMove(
  valuation: Pick<PortfolioValuation, "positions">,
  now = Date.now(),
): { change: number; changePercent: number | null; basis: string | null } | null {
  let change = 0;
  let previousValue = 0;
  const bases: Array<QuoteChangeBasis | null> = [];
  for (const entry of valuation.positions) {
    if (!entry.position) continue;
    if (!entry.dayMove) return null;
    change += entry.dayMove.change;
    previousValue += entry.dayMove.previousValue;
    bases.push(quoteChangeBasis(entry.quote, { terms: entry.futures }));
  }
  return {
    change,
    changePercent: previousValue !== 0 ? (change / previousValue) * 100 : null,
    basis: combinedChangeBasisLabel(bases, now),
  };
}

/**
 * `Day's move: +$1,165.49 (+0.51%) vs Fri 16 Oct close`, the line a book
 * valued at the close carries; `color` tints the figures by sign, `muted` the
 * basis.
 */
export function dayMoveLine(
  move: ReturnType<typeof portfolioDayMove>,
  currency: string,
  color: (text: string, value: number) => string = (text) => text,
  muted: (text: string) => string = (text) => text,
): string {
  if (!move) return "Day's move: unavailable";
  const percent = move.changePercent != null ? ` (${formatPercentRaw(move.changePercent)})` : "";
  const basis = move.basis ? ` ${muted(move.basis)}` : "";
  return `Day's move: ${color(`${formatAllocationMoney(move.change, currency, { signed: true })}${percent}`, move.change)}${basis}`;
}

/**
 * `Exposure: long $600,000, short -$419,800,000, net -$419,200,000, gross $420,400,000`:
 * what the priced holdings are worth on each side, in whole units, a short negative as every value is.
 */
export function exposureLine(exposure: PortfolioExposure, currency: string): string {
  const money = (value: number) => formatAllocationMoney(value, currency, { whole: true });
  return `Exposure: long ${money(exposure.long)}, short ${money(exposure.short)}, net ${money(exposure.net)}, gross ${money(exposure.gross)}`;
}

/** What a hedged book's weights divide, in whole units as the exposure line states it; null for a book weighed on its total. */
export function weightBasisLine(allocation: Pick<PortfolioAllocation, "weightBasis" | "weightBase">, currency: string): string | null {
  return weightBasisNote(allocation, (value) => formatAllocationMoney(value, currency, { whole: true }));
}

/** `47h old`, or `3 days old` past two days: how far behind a stale rate is. */
function rateAge(asOf: number, now: number): string {
  const hours = Math.max(0, Math.floor((now - asOf) / 3_600_000));
  return hours < 48 ? `${hours}h old` : `${Math.floor(hours / 24)} days old`;
}

/** A rate the report converted at, as markets quote the pair and `fx` writes it, for `--json`. */
function fxRateRecord({ currency, baseCurrency, rate, asOf, stale }: BaseConversion) {
  const quoted = quotedFxPair(currency, baseCurrency, rate);
  return { currency, baseCurrency, pair: quoted.pair, rate: Number(formatFxRate(quoted.rate)), asOf: asOf == null ? null : new Date(asOf).toISOString(), stale };
}

/**
 * `FX: USD/ZAR 16.7237, as of Fri 30 Oct 18:12 UTC`: each rate a portfolio's
 * holdings in another currency were converted at, as markets quote the pair,
 * dated; one past its fresh window says it is stale and how old. Null when
 * nothing was converted.
 */
function fxRatesLine(
  conversions: readonly BaseConversion[],
  { now = Date.now(), warning = (text: string) => text }: { now?: number; warning?: (text: string) => string } = {},
): string | null {
  const rates = conversions.filter((conversion) => conversion.currency !== conversion.baseCurrency && Number.isFinite(conversion.rate));
  if (rates.length === 0) return null;
  return `FX: ${rates.map((conversion) => {
    const quoted = quotedFxPair(conversion.currency, conversion.baseCurrency, conversion.rate);
    const dated = conversion.asOf == null ? "" : `, as of ${formatUtcDayTime({ time: conversion.asOf, dateOnly: false }, now)} UTC`;
    const text = `${quoted.pair} ${formatFxRate(quoted.rate)}${dated}`;
    return conversion.stale ? warning(`${text} (stale${conversion.asOf == null ? "" : `, ${rateAge(conversion.asOf, now)}`})`) : text;
  }).join("; ")}`;
}

/** What the TOTAL row weighs: all of a total; nothing on a gross base, where the weights net to the book's net over its gross. */
function totalWeight(allocation: Pick<PortfolioAllocation, "weightBasis" | "total">): number | null {
  return allocation.weightBasis === "total" && allocation.total != null && allocation.total > 0 ? 100 : null;
}

/** A portfolio's cash line, as `portfolio show` and `fn PF` report it. */
export interface PortfolioCashReport {
  /** In the cash's own currency. */
  amount: number;
  currency: string;
  /** Recorded with `portfolio cash set`, or reported by the broker account. */
  source: "manual" | "broker";
  /** In the portfolio's currency; null when the rate is unavailable. */
  value: number | null;
}

/**
 * Weights, targets and trades for a valued portfolio, with its cash: the
 * broker account's when it reports one, else the amount entered by hand.
 */
export async function valuePortfolioAllocation({
  valuation,
  portfolio,
  account,
  toBase,
}: {
  valuation: Pick<PortfolioValuation, "holdings">;
  portfolio: Portfolio;
  account?: BrokerAccount | null;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
}): Promise<{ allocation: PortfolioAllocation; cash: PortfolioCashReport | null }> {
  const line = resolvePortfolioCash(portfolio, account);
  const value = line && line.currency ? await toBase(line.amount, line.currency) : null;
  const cash = line ? { amount: line.amount, currency: line.currency, source: line.source, value: value != null && Number.isFinite(value) ? value : null } : null;
  const allocation = buildPortfolioAllocation({
    holdings: valuation.holdings,
    cashValue: cash ? cash.value ?? Number.NaN : null,
    targets: portfolio.targetWeights,
  });
  return { allocation, cash };
}

/** Colors a signed figure only when its text shows a nonzero digit. */
function signed(text: string, value: number | null | undefined): string {
  return /[1-9]/.test(text) ? colorBySign(text, value) : text;
}

const NOT_AVAILABLE = "n/a";

/**
 * What a table row calls a listing: SAN:EPA or SAN:NYSE, as the add, remove and
 * target messages name it, not the key it is stored under (SAN, SAN:XNYS),
 * which leaves two listings of one symbol looking alike. JSON and CSV keep the
 * stored key in `symbol`.
 */
export function listingLabel(ticker: TickerRecord): string {
  return savedListingName(ticker).key;
}

/** One cell per extended column: the print and its move from the close, as `quote` prints it, or blank. */
function extendedCells(
  sessions: readonly ExtendedSession[],
  extended: ExtendedSessionDisplay | null,
  quote: CollectionQuote | undefined,
  assetCategory: string | undefined,
): string[] {
  return sessions.map((session) => extended?.session === session && quote
    ? `${formatListPrice(extended.price, quote, assetCategory)}${extended.mark ? " mid" : ""} ${colorBySign(formatPercentRaw(extended.changePercent), extended.change)}`
    : "");
}

/**
 * The observations a portfolio's value is dated by, one per quote: when the
 * price it is valued at is from, with the quote's feed, delay and venue.
 */
function valuationObservations(positions: readonly PortfolioPositionValue[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return positions.flatMap(({ ticker, quote, valuation }) => {
    if (!quote || seen.has(ticker.metadata.ticker)) return [];
    seen.add(ticker.metadata.ticker);
    return [{ ...quoteFreshnessFields(quote), valuationAsOf: valuation.valuationAsOf }];
  });
}

/**
 * How current a valued portfolio is: dated by the prices its value uses, the
 * regular close when it is valued there, and in exports by the oldest of them
 * too (`citeOldest`), so an audit file does not date an equity's Friday price
 * by the newest row. `note` names the basis where no header line does.
 */
function portfolioValuationFreshness(
  valuation: Pick<PortfolioValuation, "positions" | "basis">,
  source: string,
  { note = false, now = Date.now() }: { note?: boolean; now?: number } = {},
) {
  const observations = valuationObservations(valuation.positions);
  if (observations.length === 0) return undefined;
  return rowsFreshness(observations, {
    source,
    observedKey: "valuationAsOf",
    citeOldest: true,
    ...(note ? { note: `priced at ${valuationBasisLabel(valuation.basis, { futures: holdsFutures(valuation) })}` } : {}),
  }, undefined, now);
}

/** Whether a valued book holds a future, whose price at the close is its settlement. */
export function holdsFutures(valuation: Pick<PortfolioValuation, "positions">): boolean {
  return valuation.positions.some((entry) => entry.position && entry.futures);
}

/** `Priced at the latest print, extended hours included`: the line under a portfolio's title. */
function valuationBasisLine(basis: PortfolioValuationBasis, futures: boolean): string {
  return `Priced at ${valuationBasisLabel(basis, { futures })}`;
}

/**
 * An As of cell: when the price a row's value uses is from (`valuationAsOf`),
 * in UTC as its header says; a close dated only by its day says so, and a
 * future's settlement names its session.
 */
export function valuationTimeText(value: unknown, now = Date.now(), kind?: "settle"): string {
  const time = parseReportTime(value);
  if (!time) return "—";
  return time.dateOnly ? `${formatUtcDayTime(time, now)} ${kind ?? "close"}` : formatUtcDayTime(time, now);
}

/** A yield in percent with two decimals, as DVD shows one: 2.31%. */
function formatIncomeYield(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(2)}%` : "—";
}

/** One holding's projected years, for the DRIP table and its export. */
interface DripProjection {
  ticker: TickerRecord;
  dividend: HoldingDividend & { perShare: number; currency: string; price: number };
  shares: number;
  years: DripYear[];
}

async function showCollectionWithMarketData(
  name: string,
  ctx: CliCommandContext,
  { config, store, dataProvider, persistence }: MarketContext,
  { explain = false, basis = "latest-print", drip, dividendDeadlineMs = DIVIDEND_READ_DEADLINE_MS, futuresSources, costFxHistory = apiClient }: ShowCollectionOptions,
) {
  const tickers = (await store.loadAllTickers()).sort((left, right) =>
    left.metadata.ticker.localeCompare(right.metadata.ticker)
  );
  const collection = findCollection(config, name);

  if (!collection) {
    ctx.fail(
      `Collection "${name}" was not found.`,
      `Available: ${[...config.portfolios.map((portfolio) => portfolio.name), ...config.watchlists.map((watchlist) => watchlist.name)].join(", ")}`,
    );
  }

  const matchedPortfolio = collection.kind === "portfolio" ? collection.portfolio : undefined;
  if (!matchedPortfolio && basis === "regular-close") {
    ctx.fail(`--close values a portfolio; "${collection.name}" is a watchlist.`, "Usage: gloom portfolio show <portfolio> --close");
  }
  if (!matchedPortfolio && drip) {
    ctx.fail(`--drip projects a portfolio's dividends; "${collection.name}" is a watchlist.`, "Usage: gloom portfolio show <portfolio> --drip");
  }
  const isPortfolio = !!matchedPortfolio;
  const id = collection.id;
  const displayName = collection.name;
  const structured = ctx.cliOptions?.format != null && ctx.cliOptions.format !== "text";
  const filtered = tickers.filter((ticker) =>
    isPortfolio ? ticker.metadata.portfolios.includes(id) : ticker.metadata.watchlists.includes(id)
  );
  // A portfolio reports in its own currency, as its pane totals; a watchlist in the base currency.
  const currency = resolvePortfolioTotalsCurrency(matchedPortfolio, config.baseCurrency);
  const toBase = createBaseConverter(dataProvider, currency);
  const account = matchedPortfolio ? findCachedPortfolioAccount(config, matchedPortfolio, persistence?.resources) : null;
  const hasCash = !!resolvePortfolioCash(matchedPortfolio, account) || hasTargetWeights(matchedPortfolio);

  if (filtered.length === 0 && !structured && !hasCash) {
    console.log(cliStyles.bold(displayName));
    console.log(cliStyles.muted("No tickers in this collection."));
    if (explain) console.log(`\n${renderReportGlossary(EXPLAINED_REPORT, [])}`);
    return;
  }
  // The terms the report shows, which --explain follows it with.
  let explained: GlossaryEntry[] = [];

  const futuresHeld = filtered.filter((ticker) => isFuturesTicker(ticker)
    && ticker.metadata.positions.some((position) => position.portfolio === id && position.shares !== 0));
  const [quotes, futures, purchaseDateFx] = await Promise.all([
    loadCollectionQuotes(filtered, collection, dataProvider, { datesChangeBasis: basis === "regular-close" }),
    isPortfolio ? loadPortfolioFuturesTerms(futuresHeld, {
      settlement: basis === "regular-close",
      sources: { history: dailyFuturesHistory(dataProvider), ...futuresSources },
    }) : undefined,
    isPortfolio ? loadPurchaseDateCostFx(filtered, { into: currency, history: costFxHistory, portfolioId: id }) : undefined,
  ]);
  // Worst of across the holdings' quotes, as the PORT and watchlist reports state it.
  const broker = !!(matchedPortfolio?.brokerId || matchedPortfolio?.brokerInstanceId);
  const source = !isPortfolio ? "Local watchlist and Gloom Cloud"
    : broker ? "Your broker account and Gloom Cloud" : "Local portfolio and Gloom Cloud";
  let freshness = isPortfolio ? undefined : quotesFreshness(quotes.values(), { source });
  // A watchlist's stale rows, named under the closing line that counts them.
  let staleNote: string | null = null;

  if (!structured) {
    console.log(cliStyles.bold(displayName + (isPortfolio ? ` (${currency})` : "")));
    console.log(cliStyles.muted(`${filtered.length} ticker${filtered.length === 1 ? "" : "s"}`));
    const imported = matchedPortfolio ? importedFromText(matchedPortfolio) : null;
    if (imported) console.log(cliStyles.muted(imported));
    if (isPortfolio) console.log(cliStyles.muted(valuationBasisLine(basis, futuresHeld.length > 0)));
    console.log("");
  }

  if (matchedPortfolio) {
    const valuation = await valuePortfolioPositions({ tickers: filtered, quotes, portfolioId: id, currency, baseCurrency: config.baseCurrency, toBase, basis, futures, purchaseDateFx });
    // Exports carry no header line, so their source line names the basis.
    freshness = portfolioValuationFreshness(valuation, source, { note: structured });
    const {
      positions: valued,
      totalPnl,
      unavailablePnl,
      unavailableCost,
      unavailableMarketValue,
      brokerPnlSymbols,
      unknownContractSize,
      unsettled,
      costAtTodaysRate,
      exposure,
    } = valuation;
    const { allocation, cash } = await valuePortfolioAllocation({ valuation, portfolio: matchedPortfolio, account, toBase });
    const allocationBySymbol = new Map(allocation.rows.map((row) => [row.symbol, row]));
    // What each holding pays a year: trailing dividends per share times its shares, in the portfolio's currency.
    // By symbol: a lot whose cost converts at its purchase date's FX close is valued on a copy of its record.
    const held = filtered.filter((ticker) => valued.some((entry) => entry.ticker.metadata.ticker === ticker.metadata.ticker && entry.position));
    const { dividends } = await loadHoldingDividends(held, quotes, dataProvider, { deadlineMs: dividendDeadlineMs });
    // Lots without a position or shares are no lot of income; a row of their own keeps its place with none.
    const income = await portfolioIncome(valued.map((entry) => ({
      symbol: entry.position && entry.metrics ? entry.ticker.metadata.ticker : "",
      shares: entry.metrics?.totalShares ?? 0,
      value: typeof entry.row.marketValue === "number" ? entry.row.marketValue : null,
    })), dividends, toBase);
    const lotIncome = income.lots;
    const totalIncome = income.totalIncome;
    // The yield is on what is invested: cash pays no dividend, so it does not dilute it. A long-only book's is
    // its priced holdings' net value. A book that holds a short is weighed on its gross exposure, and so is its
    // yield: the net shrinks as the hedge grows (long 100k against short 80k nets 20k), which would inflate it.
    const hedged = allocation.weightBasis === "gross";
    const yieldBase = hedged ? allocation.weightBase : exposure.net;
    const portfolioYield = totalIncome != null && yieldBase != null && yieldBase > 0 ? (totalIncome / yieldBase) * 100 : null;
    const incomeUnavailable = [...income.gaps].map(([symbol, gap]) => ({ symbol, ...gap }));
    const showTargets = allocation.targetSum != null;
    // Never dropped on a narrow terminal, so --explain reads the terms off them.
    const allocationHeaders = showTargets ? ["Weight", "Target", "Drift", "Trade", "Trade Value"] : ["Weight"];
    explained = reportGlossary("PF", allocationHeaders.join("  "));
    // A ticker held in several lots carries its allocation, the whole position's, on its first row.
    const firstRows = new Set<string>();
    const lotCounts = new Map<string, number>();
    for (const entry of valued) {
      if (entry.position) lotCounts.set(entry.ticker.metadata.ticker, (lotCounts.get(entry.ticker.metadata.ticker) ?? 0) + 1);
    }
    const positionsExport = valued.map((entry, index): Record<string, unknown> & {
      weight: number | null; targetWeight: number | null; drift: number | null; tradeShares: number | null; tradeValue: number | null;
      annualIncome: number | null; incomeYield: number | null;
    } => {
      const symbol = entry.ticker.metadata.ticker;
      const first = !firstRows.has(symbol);
      firstRows.add(symbol);
      const figures = first ? allocationBySymbol.get(symbol) : undefined;
      const dividend = entry.position ? dividends.get(symbol) : undefined;
      const lots = lotCounts.get(symbol) ?? 0;
      return {
        ...entry.row,
        weight: figures?.weight ?? null,
        targetWeight: figures?.targetWeight ?? null,
        drift: figures?.drift ?? null,
        tradeShares: figures?.tradeUnits ?? null,
        tradeValue: figures?.tradeValue ?? null,
        ...entry.valuation,
        // After the valuation fields, so every column an export had keeps its place.
        dividendPerShare: dividend?.perShare ?? null,
        dividendCurrency: dividend?.currency ?? null,
        annualIncome: lotIncome[index]?.income ?? null,
        incomeYield: lotIncome[index]?.yield ?? null,
        // Only the rows of a ticker held in several lots: `lots` says the allocation on its first row is the whole position's, `lotWeight` is this lot's own share.
        ...(lots > 1 ? { lots, lotWeight: lotWeight(typeof entry.row.marketValue === "number" ? entry.row.marketValue : null, allocation.weightBase) } : {}),
        // Only on a future: `shares` counts contracts, each `contractMultiplier` units of the price, as the exchange sizes it.
        ...(entry.futures && entry.position ? {
          contractMultiplier: entry.position.multiplier ?? null,
          contractSize: entry.futures.size?.size ?? null,
        } : {}),
        // Only on a lot held in another currency: the rate its cost converted at when bought, null when at today's.
        ...(entry.costFx !== undefined ? { costFxRate: entry.costFx?.rate ?? null, costFxCurrency: entry.costFx?.currency ?? null } : {}),
      };
    });
    const totalPnlValue = unavailablePnl.size > 0 ? null : totalPnl;
    // At the close, the value is Last times the shares, so the day's move from the close before is said beside it.
    const dayMove = basis === "regular-close" ? portfolioDayMove(valuation) : null;
    const cashExport = cash && allocation.cash ? {
      ...cash,
      weight: allocation.cash.weight,
      targetWeight: allocation.cash.targetWeight,
      drift: allocation.cash.drift,
      tradeValue: allocation.cash.tradeValue,
    } : allocation.cash ? {
      amount: 0, currency, source: "manual" as const, value: 0,
      weight: allocation.cash.weight, targetWeight: allocation.cash.targetWeight,
      drift: allocation.cash.drift, tradeValue: allocation.cash.tradeValue,
    } : null;

    // `--drip`: each holding with a known income and a price, its lots netted: a long reinvests, a short owes.
    const dripNotProjected = new Set<string>();
    const dripProjections: DripProjection[] = [];
    if (drip) {
      for (const ticker of held) {
        const symbol = ticker.metadata.ticker;
        const dividend = dividends.get(symbol);
        if (!dividend) continue;
        const shares = valued.filter((entry) => entry.ticker.metadata.ticker === symbol && entry.position && entry.metrics)
          .reduce((sum, entry) => sum + entry.metrics!.totalShares, 0);
        if (shares === 0) continue;
        // Income the table could not show is not projected either; the note under it says why.
        if (income.gaps.has(symbol) || dividend.perShare == null || !dividend.currency) continue;
        if (dividend.perShare === 0) continue;
        if (dividend.price == null || !(dividend.price > 0)) {
          dripNotProjected.add(symbol);
          continue;
        }
        const rate = await toBase(1, dividend.currency);
        if (!Number.isFinite(rate) || rate <= 0) {
          dripNotProjected.add(symbol);
          continue;
        }
        dripProjections.push({
          ticker, shares,
          dividend: { ...dividend, perShare: dividend.perShare, currency: dividend.currency, price: dividend.price },
          years: projectDrip({ symbol, shares, perShare: dividend.perShare, price: dividend.price, rate }, drip),
        });
      }
    }
    const dripAsOf = isoDateToday();
    const dripMethod = drip
      ? `Trailing twelve-month dividends per share, share prices and exchange rates as of ${dripAsOf} held flat; ${drip.withholding}% withheld from each dividend; what is left buys shares once a year, at the year's end. A short owes each dividend in full, every year, and reinvests nothing.`
      : null;

    const accountingBasis = "Unrealized P&L on current positions; excludes realized trades, distributions and cash flows. This is not account investment return.";
    const manualAccounting = !matchedPortfolio.brokerId && !matchedPortfolio.brokerInstanceId
      ? "Manual holdings are snapshots. Reconcile shares and per-share cost after corporate actions using portfolio position set; cash distributions are not credited."
      : null;
    if (structured && drip) {
      const rows = dripProjections.flatMap(({ ticker, dividend, years }) => years.map((year) => ({
        symbol: ticker.metadata.ticker, listing: listingLabel(ticker), year: year.year,
        shares: year.shares, addedShares: year.addedShares,
        dividendPerShare: dividend.perShare, dividendCurrency: dividend.currency, price: dividend.price,
        grossIncome: year.grossIncome, withheld: year.withheld, netIncome: year.netIncome,
        netIncomeBase: year.netIncomeBase, valueBase: year.valueBase, baseCurrency: currency,
      })));
      ctx.printResult({ data: rows, metadata: {
        portfolioId: id, portfolioName: displayName, baseCurrency: currency,
        years: drip.years, withholdingPercent: drip.withholding, asOf: dripAsOf, method: dripMethod,
        annualIncome: totalIncome, knownAnnualIncome: income.knownIncome, portfolioYield,
        incomeComplete: income.gaps.size === 0, incomeUnavailable,
        notProjectedSymbols: [...dripNotProjected, ...income.gaps.keys()],
        complete: income.gaps.size === 0 && dripNotProjected.size === 0,
      }, freshness });
      return;
    }
    if (structured) {
      // CSV and NDJSON read the cash and the total as rows; JSON keeps them in the metadata.
      const extraRows: Record<string, unknown>[] = [
        ...(cashExport ? [{ symbol: CASH_SYMBOL, marketValue: cashExport.value, baseCurrency: currency, weight: cashExport.weight,
          targetWeight: cashExport.targetWeight, drift: cashExport.drift, tradeShares: null, tradeValue: cashExport.tradeValue }] : []),
        { symbol: "TOTAL", marketValue: allocation.total, unrealizedPnl: totalPnlValue, baseCurrency: currency,
          weight: totalWeight(allocation), targetWeight: allocation.targetSum, valuationBasis: basis,
          annualIncome: totalIncome, incomeYield: portfolioYield },
      ];
      ctx.printResult({ data: positionsExport, metadata: {
        portfolioId: id, portfolioName: displayName, baseCurrency: currency, currency,
        valuationBasis: basis,
        total: allocation.total, cash: cashExport, targetSum: allocation.targetSum,
        // Only on a book that holds a short: its weights are shares of `weightBase`, its gross exposure, not of the total.
        ...(allocation.weightBasis === "gross" ? { weightBasis: allocation.weightBasis, weightBase: allocation.weightBase } : {}),
        ...(basis === "regular-close" ? { dayChange: dayMove?.change ?? null, dayChangePercent: dayMove?.changePercent ?? null, dayChangeBasis: dayMove?.basis ?? null } : {}),
        unpricedCount: allocation.unpriced.length, unpricedSymbols: allocation.unpriced,
        totalUnrealizedPnl: totalPnlValue,
        annualIncome: totalIncome, knownAnnualIncome: income.knownIncome, portfolioYield,
        incomeComplete: income.gaps.size === 0, incomeUnavailable,
        incomeBasis: "Trailing twelve-month dividends per share times shares held, in the portfolio's currency; a short owes the dividend, so its income is negative. Portfolio yield is the total over the invested value without cash: the priced holdings' net value (exposure.net), or for a book that holds a short its gross exposure (weightBase), as its weights are; annualIncome is null when any holding's income is unknown, and knownAnnualIncome sums the holdings that have one.",
        // Each rate a holding in another currency was converted at, dated, and whether it is stale.
        fxRates: toBase.conversions().filter((conversion) => conversion.currency !== conversion.baseCurrency).map(fxRateRecord),
        complete: unavailablePnl.size === 0 && unavailableCost.size === 0 && unavailableMarketValue.size === 0 && income.gaps.size === 0,
        unavailableSymbols: [...new Set([...unavailablePnl, ...unavailableCost, ...unavailableMarketValue])],
        unavailableCostSymbols: [...unavailableCost], brokerPnlSymbols: [...brokerPnlSymbols],
        // The priced holdings' market value: longs, shorts (negative), net and gross. Cash and unpriced holdings are not in it.
        exposure,
        ...(unknownContractSize.size > 0 ? { unknownContractSizeSymbols: [...unknownContractSize] } : {}),
        ...(unsettled.size > 0 ? { unsettledSymbols: [...unsettled] } : {}),
        // Holdings in another currency whose cost converts at today's rate: no purchase date or cost FX rate, or the date's close was not read.
        ...(costAtTodaysRate.size > 0 ? { costAtTodaysRateSymbols: [...costAtTodaysRate] } : {}),
        accountingBasis, ...(manualAccounting ? { manualAccounting } : {}),
        ...(matchedPortfolio.importedFrom ? { importedFrom: matchedPortfolio.importedFrom } : {}),
        ...(explain ? { glossary: glossaryExport(explained) } : {}),
      }, freshness }, { rows: (data) => [...(data as Record<string, unknown>[]), ...extraRows] });
      return;
    }

    const money = (value: number | null | undefined, options?: { signed?: boolean }) => formatAllocationMoney(value, currency, options);
    // Values and trades in whole units keep the table inside 80 columns; prices, costs and P&L keep the minor unit.
    const wholeMoney = (value: number | null | undefined, options?: { signed?: boolean }) => formatAllocationMoney(value, currency, { ...options, whole: true });
    const allocationCells = (
      figures: { weight: number | null; targetWeight: number | null; drift: number | null; tradeValue: number | null; tradeUnits?: number | null } | undefined,
      { unpriced, units, assetCategory }: { unpriced: boolean; units?: number; assetCategory?: string },
    ): string[] => {
      const missing = unpriced ? NOT_AVAILABLE : "—";
      const weight = figures?.weight != null ? formatAllocationWeight(figures.weight) : missing;
      if (!showTargets) return [weight];
      const target = figures?.targetWeight != null ? formatAllocationWeight(figures.targetWeight) : "—";
      const hasTarget = figures?.targetWeight != null;
      const drift = figures?.drift != null ? signed(formatAllocationDrift(figures.drift), figures.drift) : hasTarget ? missing : "—";
      const trade = units == null ? "" : figures?.tradeUnits != null
        ? signed(formatTradeUnits(figures.tradeUnits, { units, assetCategory }), figures.tradeUnits)
        : hasTarget ? missing : "—";
      const tradeValue = figures?.tradeValue != null ? signed(wholeMoney(figures.tradeValue, { signed: true }), figures.tradeValue) : hasTarget ? missing : "—";
      return [weight, target, drift, trade, tradeValue];
    };

    // Income and its yield, once any share or fund has one or only lacks a rate into the portfolio's currency; otherwise the note under the table says why.
    const showIncome = showsIncomeColumns(income);
    const incomeCells = (income: number | null | undefined, yieldPercent: number | null | undefined): string[] =>
      showIncome ? [money(income), formatIncomeYield(yieldPercent)] : [];
    const extendedSessions = extendedSessionsOf(valued.map(({ extended }) => extended?.session));
    const now = Date.now();
    // Where each ticker's lots end, to put its position line there.
    const lastLot = new Map<string, number>();
    valued.forEach((entry, index) => { if (entry.position) lastLot.set(entry.ticker.metadata.ticker, index); });
    const rows: string[][] = valued.flatMap(({ ticker, quote, headline, extended, position, metrics, pnl, row, valuation: priced, futures: contract }, index): string[][] => {
      const asOf = valuationTimeText(priced.valuationAsOf, now, priced.valuationPriceKind);
      const priceText = quote && headline
        ? colorBySign(formatListPrice(headline.price, quote, ticker.metadata.assetCategory), headline.change)
        : "—";
      const changeText = headline ? colorBySign(formatPercentRaw(headline.changePercent), headline.change) : "—";
      const quoteCells = [priceText, changeText, ...extendedCells(extendedSessions, extended, quote, ticker.metadata.assetCategory)];
      const exported = positionsExport[index]!;
      const symbol = ticker.metadata.ticker;
      const lots = lotCounts.get(symbol) ?? 0;
      // A lot of several weighs by its own value; its target, drift and trade belong to the position, on the line under its lots.
      const figures = lots > 1
        ? { weight: exported.lotWeight as number | null, targetWeight: null, drift: null, tradeValue: null, tradeUnits: null }
        : exported.weight != null || exported.targetWeight != null || exported.tradeValue != null
          ? { weight: exported.weight, targetWeight: exported.targetWeight, drift: exported.drift, tradeValue: exported.tradeValue, tradeUnits: exported.tradeShares }
          : undefined;
      const symbolUnits = allocationBySymbol.get(symbol)?.units ?? 0;
      if (!position || !metrics) {
        return [[listingLabel(ticker), ...quoteCells, "—", "—", "—",
          ...allocationCells(figures, { unpriced: false, units: symbolUnits, assetCategory: ticker.metadata.assetCategory }),
          ...incomeCells(null, null), "—", asOf]];
      }
      const positionCurrency = metrics.positionCurrency;
      const marketValue = row.marketValue as number | null;
      const unpriced = marketValue == null;
      const quantityOptions = { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency };
      // A future counts contracts, each the size its terms give: 1,000 × 100 oz.
      const quantity = (units: number) => contract
        ? futuresQuantityText(formatMarketQuantity(units, quantityOptions), contract.size
          ?? (position.multiplier ? { size: formatMarketQuantity(position.multiplier) } : null))
        : formatMarketQuantity(units, quantityOptions);
      const lotRow = [
        listingLabel(ticker),
        ...quoteCells,
        quantity(metrics.totalShares),
        formatMarketCostWithCurrency(position.avgCost, positionCurrency, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis }),
        unpriced ? NOT_AVAILABLE : wholeMoney(marketValue),
        ...allocationCells(figures, { unpriced, units: symbolUnits, assetCategory: ticker.metadata.assetCategory }),
        ...incomeCells(exported.annualIncome, exported.incomeYield),
        pnl == null || !Number.isFinite(pnl) ? "—" : colorBySign(money(pnl, { signed: true }), pnl),
        asOf,
      ];
      if (lots < 2 || lastLot.get(symbol) !== index) return [lotRow];
      // The whole position under its lots: its shares and value, and the weight, target, drift and trade they add up to.
      const whole = allocationBySymbol.get(symbol);
      const wholeValue = whole?.marketValue ?? null;
      return [lotRow, [`${listingLabel(ticker)} (${lots} lots)`, "", "", ...extendedSessions.map(() => ""),
        quantity(symbolUnits), "", wholeValue == null ? NOT_AVAILABLE : wholeMoney(wholeValue),
        ...allocationCells(whole, { unpriced: wholeValue == null, units: symbolUnits, assetCategory: ticker.metadata.assetCategory }),
        ...(showIncome ? ["", ""] : []), "", ""]];
    });
    if (cashExport) {
      const label = cashExport.currency && cashExport.currency !== currency ? `${CASH_SYMBOL} ${cashExport.currency}` : CASH_SYMBOL;
      rows.push([label, "", "", ...extendedSessions.map(() => ""), "", "", cashExport.value == null ? NOT_AVAILABLE : wholeMoney(cashExport.value),
        ...allocationCells(cashExport, { unpriced: cashExport.value == null }), ...(showIncome ? ["", ""] : []), "", ""]);
    }
    const total = allocation.total;
    rows.push([
      cliStyles.bold("TOTAL"), "", "", ...extendedSessions.map(() => ""), "", "",
      cliStyles.bold(wholeMoney(total)),
      formatAllocationWeight(totalWeight(allocation)),
      ...(showTargets ? [formatAllocationWeight(allocation.targetSum), "", "", ""] : []),
      ...(showIncome ? [cliStyles.bold(money(totalIncome)), formatIncomeYield(portfolioYield)] : []),
      totalPnlValue == null ? "—" : colorBySign(money(totalPnlValue, { signed: true }), totalPnlValue),
      "",
    ]);

    // Face amounts and contracts are not shares.
    const quantityHeader = filtered.some(ticker => ticker.metadata.assetCategory?.toUpperCase() === "BOND") || positionsExport.some(row => row.quantityUnit === "face")
      || holdsFutures(valuation) ? "Qty" : "Shares";
    // A narrow terminal drops the cost, then the quote, then P&L, before any of the allocation.
    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Last", align: "right", optional: true, dropPriority: 1 },
        { header: "Chg", align: "right", optional: true, dropPriority: 2 },
        // Before Chg, after Avg Cost, which is right of it at the same priority.
        ...extendedSessions.map((session) => ({ header: EXTENDED_SESSION_LABELS[session], align: "right" as const, optional: true, dropPriority: 3 })),
        { header: quantityHeader, align: "right" },
        { header: "Avg Cost", align: "right", optional: true, dropPriority: 3 },
        { header: "Value", align: "right" },
        ...allocationHeaders.map((header) => ({ header, align: "right" as const })),
        // A year of trailing dividends on the shares held, dropped after the quote and before P&L.
        ...(showIncome ? [
          { header: "Income", align: "right" as const, optional: true, dropPriority: 0.5 },
          { header: "Yield", align: "right" as const, optional: true, dropPriority: 0.5 },
        ] : []),
        { header: "P&L", align: "right", optional: true },
        // When each row's price is from, so a Friday close never hides behind a newer row.
        { header: "As of (UTC)" },
      ],
      rows,
    ));
    console.log("");
    if (basis === "regular-close") console.log(dayMoveLine(dayMove, currency, colorBySign, cliStyles.muted));
    if (valued.some((entry) => entry.position)) console.log(exposureLine(exposure, currency));
    // The rates the holdings in another currency are valued at, dated, so a stale one is seen beside the value it moves.
    const fxLine = fxRatesLine(toBase.conversions(), { warning: cliStyles.warning });
    if (fxLine) console.log(fxLine);
    const notes: string[] = [];
    // TOTAL's yield says what it divides: a hedged book's gross exposure, or, with cash in the book, the holdings alone.
    if (showIncome && portfolioYield != null && yieldBase != null && hedged) {
      notes.push(cliStyles.muted(`TOTAL yield is income over the gross exposure of ${wholeMoney(yieldBase)}, as the book holds a short; cash excluded.`));
    } else if (showIncome && portfolioYield != null && yieldBase != null && cashExport?.value) {
      notes.push(cliStyles.muted(`TOTAL yield is income over the invested ${wholeMoney(yieldBase)}, cash excluded.`));
    }
    const weightNote = weightBasisLine(allocation, currency);
    if (weightNote) notes.push(cliStyles.muted(weightNote));
    // The notes name the rows as the table does.
    const labels = new Map(filtered.map((ticker) => [ticker.metadata.ticker, listingLabel(ticker)]));
    const named = (symbols: Iterable<string>) => [...symbols].map((symbol) => labels.get(symbol) ?? symbol).join(", ");
    // A future without its contract size or settlement is said once, not as a missing cost, value and P&L.
    const unsized = (symbols: ReadonlySet<string>) => [...symbols].filter((symbol) => !unknownContractSize.has(symbol) && !unsettled.has(symbol));
    if (allocation.unpriced.length > 0) {
      const count = allocation.unpriced.length;
      notes.push(cliStyles.warning(`Total and weights exclude ${count} unpriced holding${count === 1 ? "" : "s"}: ${named(allocation.unpriced)}.`));
    }
    if (cashExport?.source === "broker") notes.push(cliStyles.muted("Cash is the broker account's balance as of its last sync."));
    if (matchedPortfolio.brokerInstanceId && !account) notes.push(cliStyles.warning(BROKER_ACCOUNT_MISSING_NOTE));
    if (cashExport && cashExport.value == null) {
      notes.push(cliStyles.warning(cashExport.currency
        ? `No ${cashExport.currency}/${currency} rate for the cash, so the total and weights are unavailable.`
        : "The cash's currency is unknown, so the total and weights are unavailable."));
    }
    const targetNote = describeTargetSum(allocation.targetSum, allocation.weightBasis);
    if (targetNote) notes.push(cliStyles.muted(targetNote));
    if (brokerPnlSymbols.size > 0) notes.push(cliStyles.muted(`P&L for ${named(brokerPnlSymbols)} is the broker's last snapshot.`));
    notes.push(...costAtTodaysRateNotes(valuation, named).map((note) => cliStyles.muted(note)));
    if (unknownContractSize.size > 0) {
      notes.push(cliStyles.warning(`No contract size for ${named(unknownContractSize)}, so ${unknownContractSize.size === 1 ? "its" : "their"} value, cost and P&L are not shown.`));
    }
    if (unsettled.size > 0) {
      notes.push(cliStyles.warning(`No confirmed settlement for ${named(unsettled)}, so ${unsettled.size === 1 ? "it is" : "they are"} not valued at the close.`));
    }
    if (unsized(unavailableCost).length > 0) notes.push(cliStyles.muted(`Cost unavailable for ${named(unsized(unavailableCost))}.`));
    if (unsized(unavailablePnl).length > 0) notes.push(cliStyles.muted(`P&L unavailable for ${named(unsized(unavailablePnl))}.`));
    const incomeNote = incomeGapNote(income, { name: named, money: (value) => money(value), deadlineMs: dividendDeadlineMs });
    if (incomeNote) notes.push(cliStyles.muted(incomeNote));
    for (const note of notes) console.log(note);
    if (drip) {
      console.log("");
      console.log(renderSection(`DRIP projection, ${drip.years} year${drip.years === 1 ? "" : "s"}`));
      if (dripProjections.length === 0) {
        console.log(cliStyles.muted(dividends.size === 0 ? "No shares or funds to project."
          : income.gaps.size > 0 ? "Nothing to project: the income above is unavailable." : "No holding paid a dividend in the past year."));
      } else {
        const yearNumbers = Array.from({ length: drip.years }, (_, index) => index + 1);
        const finalYear = `Shares Y${drip.years}`;
        const quantity = (value: number, ticker: TickerRecord) => formatMarketQuantity(value, { assetCategory: ticker.metadata.assetCategory });
        const dripRows = dripProjections.map(({ ticker, shares, years }) => [
          listingLabel(ticker),
          quantity(shares, ticker),
          quantity(years.at(-1)!.shares, ticker),
          ...years.map((year) => money(year.netIncomeBase)),
        ]);
        dripRows.push([
          cliStyles.bold("TOTAL"), "", "",
          ...yearNumbers.map((year) => cliStyles.bold(money(dripProjections.reduce((sum, entry) => sum + entry.years[year - 1]!.netIncomeBase, 0)))),
        ]);
        console.log(renderTable(
          [
            { header: "Ticker" },
            { header: "Shares", align: "right" },
            { header: finalYear, align: "right" },
            ...yearNumbers.map((year) => ({ header: `Y${year} income`, align: "right" as const })),
          ],
          dripRows,
        ));
        const shorts = dripProjections.some((entry) => entry.shares < 0) ? "; shorts owe each dividend in full" : "";
        console.log(cliStyles.muted(`As of ${dripAsOf}: trailing dividends, prices and FX held flat; ${drip.withholding}% withheld; reinvested once a year${shorts}.`));
      }
      const unprojected = [
        ...(income.gaps.size > 0 && dripProjections.length > 0 ? [`${named([...income.gaps.keys()])} (income unavailable above)`] : []),
        ...(dripNotProjected.size > 0 ? [`${named(dripNotProjected)} (no price to reinvest at)`] : []),
      ];
      if (unprojected.length > 0) console.log(cliStyles.muted(`Not projected: ${unprojected.join("; ")}.`));
    }
  } else {
    const watched = await valueWatchlistRows({ tickers: filtered, quotes, dataProvider, currency, toBase });
    if (structured) {
      ctx.printResult({
        data: watched.map((entry) => entry.row),
        metadata: { watchlistId: id, watchlistName: displayName, baseCurrency: currency, ...(explain ? { glossary: [] } : {}) },
        freshness,
      });
      return;
    }
    const extendedSessions = extendedSessionsOf(watched.map(({ extended }) => extended?.session));
    // Funding is the one column a list earns by holding perpetual markets; any other list's table is unchanged.
    const showFunding = watched.some(({ funding }) => funding !== undefined);
    // So is Last Trade, by holding a stale quote: the rows the closing line counts stale, dated as `quote` dates them.
    const stale = watched.filter((entry) => entry.stale);
    const rows = watched.map(({ ticker, quote, headline, extended, venue, marketCap, funding, stale: rowStale, lastTrade }) => {
      const priceText = quote && headline
        ? colorBySign(formatListPrice(headline.price, quote, ticker.metadata.assetCategory), headline.change)
        : "—";
      // A listing that no longer trades has no day's move: its last session's is years old.
      const changeText = quote?.delisting ? "—" : headline ? colorBySign(formatPercentRaw(headline.changePercent), headline.change) : "—";
      const staleText = quote?.delisting ? delistingLabel(quote.delisting) : lastTrade ? `STALE ${lastTrade}` : "STALE";
      return [
        listingLabel(ticker),
        venue ?? "—",
        priceText,
        changeText,
        ...stale.length > 0 ? [rowStale ? cliStyles.warning(staleText) : ""] : [],
        ...extendedCells(extendedSessions, extended, quote, ticker.metadata.assetCategory),
        ...showFunding ? [funding == null ? "—" : colorBySign(formatPerpetualRate(funding, 4), funding)] : [],
        marketCap == null ? "—" : `${formatCompact(marketCap)} ${currency}`,
      ];
    });

    console.log(renderTable(
      [
        { header: "Ticker" },
        { header: "Exchange" },
        { header: "Last", align: "right" },
        { header: "Chg", align: "right" },
        ...stale.length > 0 ? [{ header: "Last Trade", shrink: false }] : [],
        ...extendedSessions.map((session) => ({ header: EXTENDED_SESSION_LABELS[session], align: "right" as const, optional: true, dropPriority: 1 })),
        // As the TUI's FUND 8H: per eight hours whatever interval the venue pays on.
        ...showFunding ? [{ header: "Fund 8H", align: "right" as const, optional: true, dropPriority: 1 }] : [],
        // A narrow terminal drops these first.
        { header: "Mkt Cap", align: "right", optional: true, dropPriority: 2 },
      ],
      rows,
    ));
    const notes = marketCapNotes(watched);
    if (notes.length > 0) console.log(["", ...notes.map((note) => cliStyles.muted(note))].join("\n"));
    // The closing line counts the stale rows; the line under it names them.
    if (stale.length > 0) {
      staleNote = `Stale: ${namedList(stale.map(({ ticker, quote, lastTrade }) => `${listingLabel(ticker)}${quote?.delisting ? ` (${delistingLabel(quote.delisting)})`
        : lastTrade ? ` (last trade ${lastTrade})` : ""}`))}.`;
    }
  }
  if (freshness) console.log(`\n${cliFreshnessFooter(freshness)}${staleNote ? `\n${cliStyles.muted(staleNote)}` : ""}`);
  if (explain) console.log(`\n${renderReportGlossary(EXPLAINED_REPORT, explained)}`);
}

/** One watchlist row: the quote as the table shows it, the market cap in the base currency, and the `--json` and `--csv` row. */
interface WatchlistRowValue {
  ticker: TickerRecord;
  quote: CollectionQuote | undefined;
  headline: ActiveQuoteDisplay | null;
  extended: ExtendedSessionDisplay | null;
  kind: TickerInstrumentKind;
  /** The Exchange column: the quote's venue, else the saved one. */
  venue: string | null;
  marketCap: number | null;
  /** A perpetual market's funding per eight hours, as a fraction; null when its market cannot be read, undefined for any other row. */
  funding: number | null | undefined;
  /** Whether the quote is stale, as the closing line counts it. */
  stale: boolean;
  /** The exchange-local date of the quote's last trade. */
  lastTrade: string | null;
  row: Record<string, unknown>;
}

/** Financials requested at once, the most the app asks for at a time. */
const FINANCIALS_BATCH_SIZE = 64;
/** Financials asked for one at a time, at most this many at once, from a source without batches. */
const FINANCIALS_CONCURRENCY = 8;

/**
 * The financials of the listings whose quote carries no market cap, through
 * the same batched request the watchlist pane makes. A lightweight quote, as
 * US listings are served, leaves the capitalization to the fundamentals.
 */
async function loadMarketCapFinancials(
  tickers: readonly TickerRecord[],
  quotes: ReadonlyMap<string, CollectionQuote>,
  dataProvider: Pick<DataProvider, "getTickerFinancials" | "getTickerFinancialsBatch">,
): Promise<Map<string, TickerFinancials>> {
  const needed = tickers.filter((ticker) => !selectMarketCapitalization(quotes.get(ticker.metadata.ticker), undefined));
  const financials = new Map<string, TickerFinancials>();
  if (needed.length === 0) return financials;
  const targets = needed.map((ticker) => ({ symbol: ticker.metadata.ticker, exchange: ticker.metadata.exchange }));
  if (dataProvider.getTickerFinancialsBatch) {
    await Promise.all(chunked(targets, FINANCIALS_BATCH_SIZE).map(async (batch) => {
      const results = await dataProvider.getTickerFinancialsBatch!(batch).catch(logFailure("portfolio-list.cli.render", "Load market cap financials batch failed", []));
      batch.forEach((target, index) => {
        const value = (results.find((result) => result.target === target) ?? results[index])?.financials;
        if (value) financials.set(target.symbol, value);
      });
    }));
    return financials;
  }
  await mapWithConcurrency(targets, FINANCIALS_CONCURRENCY, async (target) => {
    const value = await dataProvider.getTickerFinancials(target.symbol, target.exchange).catch(logFailure("portfolio-list.cli.render", "Load market cap financials failed", null));
    if (value) financials.set(target.symbol, value);
  });
  return financials;
}

/** Perpetual markets read at once, the most the app asks for at a time. */
const PERPETUAL_CONCURRENCY = 8;

/**
 * The funding per eight hours of each perpetual market in a list, by ticker, as `quote` reads it: null for a market
 * that cannot be read. A list without perpetual markets reads nothing.
 */
async function loadPerpetualFunding(tickers: readonly TickerRecord[]): Promise<Map<string, number | null>> {
  const markets = tickers.flatMap((ticker) => {
    const listing = perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange);
    return listing ? [{ symbol: ticker.metadata.ticker, listing }] : [];
  });
  const funding = new Map<string, number | null>();
  await mapWithConcurrency(markets, PERPETUAL_CONCURRENCY, async ({ symbol, listing }) => {
    funding.set(symbol, await loadPerpetualMarket(listing).then((market) => market?.row.fundingRate8h ?? null, logFailure("portfolio-list.cli.render", "Load perpetual funding failed", null)));
  });
  return funding;
}

/** Watchlist rows as `watchlist show` prints them, with the market cap the watchlist pane shows. */
async function valueWatchlistRows({
  tickers,
  quotes,
  dataProvider,
  currency,
  toBase,
}: {
  tickers: readonly TickerRecord[];
  quotes: ReadonlyMap<string, CollectionQuote>;
  dataProvider: Pick<DataProvider, "getTickerFinancials" | "getTickerFinancialsBatch">;
  currency: string;
  toBase: (value: number, fromCurrency: string) => Promise<number>;
}): Promise<WatchlistRowValue[]> {
  const [financials, perpetualFunding] = await Promise.all([
    loadMarketCapFinancials(tickers, quotes, dataProvider),
    loadPerpetualFunding(tickers),
  ]);
  const known = (value: number | null | undefined): number | null => value != null && Number.isFinite(value) ? value : null;
  // The export carries funding on the table's terms: only for a list that holds perpetual markets.
  const hasPerpetuals = perpetualFunding.size > 0;
  const values: WatchlistRowValue[] = [];
  for (const ticker of tickers) {
    const symbol = ticker.metadata.ticker;
    const quote = quotes.get(symbol);
    const snapshot = financials.get(symbol);
    const { headline, extended } = collectionQuoteHeadline(quote);
    const cap = liveMarketCapitalization(quote, snapshot?.fundamentals) ?? liveMarketCapitalization(snapshot?.quote, snapshot?.fundamentals);
    const marketCap = cap ? listedMarketCapitalization(known(await toBase(cap.value, cap.currency))) : null;
    const kind = resolveTickerInstrumentKind(ticker, { quote: quote ?? snapshot?.quote });
    const venue = exchangeShortName(quote?.tradingExchangeName || quote?.exchangeName, quote?.fullExchangeName) || ticker.metadata.exchange || null;
    const funding = perpetualFunding.get(symbol);
    const stale = quoteFreshnessFields(quote).stale === true;
    const lastTrade = quote ? lastTradeDate(quote) : null;
    values.push({
      ticker, quote, headline, extended, kind, venue, marketCap, funding, stale, lastTrade,
      row: {
        symbol,
        ...listingColumns(ticker, quote),
        exchange: venue,
        kind,
        currency: quote?.currency || ticker.metadata.currency || null,
        price: known(headline?.price),
        change: known(headline?.change),
        changePercent: known(headline?.changePercent),
        ...extendedQuoteFields(extended),
        volume: known(quote?.volume),
        ...hasPerpetuals ? { fundingRate8h: known(funding) } : {},
        marketCap,
        marketCapCurrency: currency,
        // When the price shown was observed, as `quote` dates it.
        quoteAsOf: quote ? known(quoteHeadlineTime(quote)) : null,
        // A stale quote (as the source line counts it) and the exchange-local date it last traded.
        stale,
        lastTradeDate: lastTrade,
        // A listing that no longer trades: its status and last session.
        ...quote?.delisting ? { delisting: quote.delisting } : {},
      },
    });
  }
  return values;
}

/** Kinds of listing that have no market cap at all, as a note names them. */
const NO_MARKET_CAP: Partial<Record<TickerInstrumentKind, string>> = {
  fund: "funds",
  index: "indices",
  currency: "currencies",
  future: "futures",
  perpetual: "perpetuals",
  prediction: "prediction markets",
  option: "options",
  bond: "bonds",
};
const NOTE_NAMES = 10;

function namedList(labels: readonly string[]): string {
  const more = labels.length - NOTE_NAMES;
  return `${labels.slice(0, NOTE_NAMES).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Why a Mkt Cap cell is blank: funds and indices have none; a company or coin whose figure did not come is unavailable. */
function marketCapNotes(rows: readonly WatchlistRowValue[]): string[] {
  const blank = rows.filter((row) => row.marketCap == null);
  const notes: string[] = [];
  const byKind = new Map<string, string[]>();
  for (const row of blank) {
    const group = NO_MARKET_CAP[row.kind] ?? "";
    byKind.set(group, [...byKind.get(group) ?? [], listingLabel(row.ticker)]);
  }
  for (const [group, labels] of byKind) {
    if (group) notes.push(`No market cap for ${group}: ${namedList(labels)}.`);
  }
  const unavailable = byKind.get("");
  if (unavailable?.length) notes.push(`Market cap unavailable for ${namedList(unavailable)}.`);
  return notes;
}
