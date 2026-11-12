import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { convertCurrency, formatCompactAmount, formatNumber } from "../../../../utils/format";
import { currencyMinorDigits, getCurrencySymbol } from "../../../../market-data/market/format";
import { extendedPrintSession, getActiveQuoteDisplay, type ExtendedSession } from "../../../../market-data/market/status";
import { dayMoveBasisLabel, futuresQuoteFromSettle, quoteChangeBasis, type QuoteChangeBasis } from "../../../../market-data/market/change-basis";
import { isQuoteStaleForCurrentSession } from "../../../../market-data/quotes/freshness";
import { headlineQuoteDisplay } from "../../../../portfolio/column-values";
import type { AllocationHolding } from "../../../../portfolio/allocation";
import { getPortfolioValuationDisplay, type PortfolioValuationBasis } from "../../../../portfolio/valuation-basis";
import type { PortfolioFuturesTerms } from "../../../../portfolio/futures-positions";
import {
  getPortfolioPositionMetrics,
  resolvePortfolioMarketValue,
  resolvePortfolioPositionPnl,
  portfolioPnlPercent,
  type PortfolioPositionPnl,
} from "../../../../portfolio/position-metrics";

/** A position lot valued from a current quote, in the totals currency. */
interface PricedPortfolioLot {
  /** Stable for the lot while the positions stay as imported. */
  key: string;
  direction: 1 | -1;
  value: number;
  /** The broker's value for the lot at the last import, when it gave one. */
  brokerValue: number | null;
}

export interface PortfolioSummaryTotals {
  /** Gross: every lot at its absolute value. */
  totalMktValue: number;
  netMktValue?: number;
  /** The long lots' value and the short lots' (negative); net is their sum, gross their difference. */
  longMktValue?: number;
  shortMktValue?: number;
  hasShorts?: boolean;
  /** Futures held without a contract size, so they are not valued at all. */
  unknownContractSizeSymbols?: string[];
  /** Whether a future is held: at the close it is valued at its settlement. */
  hasFutures?: boolean;
  unavailableSymbols?: string[];
  unavailableCostSymbols?: string[];
  brokerPnlSymbols?: string[];
  unrealizedPnlBasis?: PortfolioPositionPnl["basis"];
  dailyPnl: number;
  dailyPnlPct: number;
  /**
   * What Day (or a watchlist's Avg Day) is measured from, as each holding's
   * change line says it: "vs Fri 16 Oct close" when they agree, "vs mixed
   * closes" when they do not (an HKEX listing beside a US one), after the
   * session of the extended-hours prints it is valued at, as the rows mark
   * them ("AH vs Tue 10 Nov close"). Absent without a move.
   */
  dayChangeBasis?: string;
  /** Some holding's day is valued at an extended-hours print, which dayChangeBasis names. */
  dayAtExtendedPrint?: boolean;
  totalCostBasis: number;
  hasPositions: boolean;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  avgWatchlistChange: number;
  watchlistCount: number;
  /** Currency pairs preventing the full portfolio from being valued. */
  unavailableConversions?: string[];
  /** Every position is valued from a current, real-time quote. */
  livePriced?: boolean;
  /** Lots with a current quote. Broker account snapshots move by these. */
  pricedLots?: PricedPortfolioLot[];
  /** Every ticker of a portfolio valued for weights and targets (see allocation.ts). */
  allocationHoldings?: AllocationHolding[];
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

function currencyCode(value: string | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return CURRENCY_CODE.test(code) ? code : null;
}

export { resolvePortfolioTotalsCurrency } from "../../../../portfolio/totals-currency";

/** From here a book's totals read in whole units (1,588), as `portfolio show` prints market values; below it, to the minor unit (101.10). */
const WHOLE_AMOUNT_FROM = 1_000;
/** From here they read compact (1.23B), so a header row keeps its other figures. */
const COMPACT_AMOUNT_FROM = 1_000_000_000;

/**
 * An amount with thousands separators: to the currency's minor unit below a
 * thousand (101.10, ¥950), in whole units from there (1,588, -40,000) and
 * compact from a billion (1.23B). A signed amount carries + or -, except one
 * that rounds to zero.
 */
function bookAmountText(value: number | undefined, currency: string, signed: boolean): string {
  if (value == null || !Number.isFinite(value)) return formatCompactAmount(value);
  const abs = Math.abs(value);
  if (abs >= COMPACT_AMOUNT_FROM) return formatCompactAmount(value, { signed });
  const minor = currencyMinorDigits(currency);
  const body = formatNumber(abs, Number(abs.toFixed(minor)) >= WHOLE_AMOUNT_FROM ? 0 : minor);
  if (!/[1-9]/.test(body)) return body;
  return `${value < 0 ? "-" : signed ? "+" : ""}${body}`;
}

/**
 * A total in the portfolio's currency (bookAmountText): never rounded to a
 * hundred, as a compact 1.6k for $1,587.80 was. Bare when both it and the
 * app's base currency are USD, as the pane has always shown it; otherwise it
 * leads with the currency symbol, as prices do: A$108,612, +$600.12.
 */
export function formatPortfolioAmount(
  value: number | undefined,
  currency: string,
  { signed = false, baseCurrency = "USD" }: { signed?: boolean; baseCurrency?: string } = {},
): string {
  const text = bookAmountText(value, currency, signed);
  const bare = currency === "USD" && (currencyCode(baseCurrency) ?? "USD") === "USD";
  if (bare || value == null || !Number.isFinite(value)) return text;
  const sign = text.startsWith("+") || text.startsWith("-") ? text.charAt(0) : "";
  return `${sign}${getCurrencySymbol(currency)}${text.slice(sign.length)}`;
}

/**
 * Totals over the collection, every amount converted into `totalsCurrency`,
 * valued at `valuationBasis`: the latest print unless given, or the regular
 * close, whose day is that session's move.
 */
export function calculatePortfolioSummaryTotals(
  tickers: TickerRecord[],
  financialsMap: Map<string, TickerFinancials>,
  totalsCurrency: string,
  exchangeRates: Map<string, number>,
  isPortfolio: boolean,
  collectionId: string | null,
  valuationBasis: PortfolioValuationBasis = "latest-print",
  /** Each future's contract size and settlement by symbol, as the rows read them. */
  futuresTerms?: ReadonlyMap<string, PortfolioFuturesTerms>,
  /**
   * Each held currency's move on the day against `totalsCurrency`, as a
   * factor (1.001 for +0.1%), from its pair's previous daily close as `fx`
   * reads it: a holding in another currency was worth its value before at
   * that close's rate, so the day's move holds the currency's own, as
   * `portfolio show` counts it. A currency not here moves with its price alone.
   */
  fxDayMoves?: ReadonlyMap<string, number>,
): PortfolioSummaryTotals {
  let totalMktValue = 0;
  let netMktValue = 0;
  let hasShorts = false;
  let hasFutures = false;
  const unknownContractSizeSymbols = new Set<string>();
  const unavailableSymbols = new Set<string>();
  const unavailableCostSymbols = new Set<string>();
  const brokerPnlSymbols = new Set<string>();
  const pnlBases = new Set<PortfolioPositionPnl["basis"]>();
  let totalPrevValue = 0;
  let totalCostBasis = 0;
  let signedDailyPnl = 0;
  let signedUnrealizedPnl = 0;
  let hasPositions = false;
  let watchlistChangeSum = 0;
  let watchlistCount = 0;
  const dayBases: Array<QuoteChangeBasis | null> = [];
  // The extended session of each price the day is valued at, null for a regular one.
  const dayPrints: Array<ExtendedSession | null> = [];
  const unavailableConversions = new Set<string>();
  let livePriced = true;
  const pricedLots: PricedPortfolioLot[] = [];
  const allocationHoldings: AllocationHolding[] = [];
  const now = Date.now();
  const toBase = (value: number, currency: string) => {
    const converted = convertCurrency(value, currency, totalsCurrency, exchangeRates);
    if (Number.isFinite(value) && !Number.isFinite(converted)) unavailableConversions.add(`${currency}/${totalsCurrency}`);
    return converted;
  };
  // The currency's move on the day, where it is known and the holding is in another currency.
  const fxMove = (currency: string) => {
    const factor = currency === totalsCurrency ? undefined : fxDayMoves?.get(currency);
    return factor != null && Number.isFinite(factor) && factor > 0 ? factor : null;
  };
  // A value at the previous close, at that close's rate where the move on the day is known.
  const toBaseBefore = (value: number, currency: string) => toBase(value, currency) / (fxMove(currency) ?? 1);

  for (const ticker of tickers) {
    const financials = financialsMap.get(ticker.metadata.ticker);
    const terms = futuresTerms?.get(ticker.metadata.ticker);
    // A future's move as FUT and `quote` measure it with its terms.
    const quote = futuresQuoteFromSettle(financials?.quote, terms);
    const displayedQuote = getActiveQuoteDisplay(quote);
    let activeQuote = displayedQuote && Number.isFinite(displayedQuote.price) ? displayedQuote : null;
    const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

    if (!isPortfolio) {
      // The CHG% column's value, so Avg Day is the mean of that column; a listing that no longer trades has none.
      const changePercent = quote?.delisting ? undefined : headlineQuoteDisplay(activeQuote, quote)?.changePercent;
      if (changePercent != null) {
        watchlistChangeSum += changePercent;
        watchlistCount++;
        dayBases.push(quoteChangeBasis(quote, { terms }));
      }
      continue;
    }

    const positionMetrics = getPortfolioPositionMetrics(ticker, collectionId ?? undefined, quoteCurrency, {
      currency: totalsCurrency, convert: toBase,
    }, quote);
    activeQuote = getPortfolioValuationDisplay(positionMetrics, quote, valuationBasis, terms?.settlement);
    const { totalPriceUnits, grossPriceUnits, totalCost } = positionMetrics;
    if (positionMetrics.positionCount === 0) {
      // Not held, so a missing rate is no gap in the totals: it only leaves the trade in units out.
      const unitPrice = activeQuote ? convertCurrency(activeQuote.price, quoteCurrency, totalsCurrency, exchangeRates) : null;
      allocationHoldings.push({ symbol: ticker.metadata.ticker, held: false, marketValue: 0, units: 0, unitPrice });
      continue;
    }
    const toBaseQuote = (value: number) => toBase(value, quoteCurrency);
    const currentUnitPrice = activeQuote ? toBaseQuote(activeQuote.price) : null;
    hasPositions = true;
    hasShorts ||= positionMetrics.hasShorts;
    hasFutures ||= positionMetrics.isFuture;
    if (positionMetrics.unknownContractSize) {
      // A future whose contract size is unknown has no value to count, never one unit a contract: it is
      // left out of every total and named, as `portfolio show` does, rather than leaving no total at all.
      unknownContractSizeSymbols.add(ticker.metadata.ticker);
      allocationHoldings.push({ symbol: ticker.metadata.ticker, held: true, marketValue: null, units: positionMetrics.totalShares, unitPrice: currentUnitPrice });
      continue;
    }
    totalCostBasis += totalCost;
    if (!positionMetrics.hasCostBasis) unavailableCostSymbols.add(ticker.metadata.ticker);

    const positionPnl = resolvePortfolioPositionPnl(positionMetrics, currentUnitPrice);
    signedUnrealizedPnl += positionPnl.value ?? Number.NaN;
    pnlBases.add(positionPnl.basis);
    if (positionPnl.basis === "broker-snapshot" || positionPnl.basis === "mixed") brokerPnlSymbols.add(ticker.metadata.ticker);

    const freshQuote = currentUnitPrice != null && Number.isFinite(currentUnitPrice)
      && !!quote && !isQuoteStaleForCurrentSession(quote, now);
    if (!freshQuote || quote.dataSource === "delayed" || quote.dataSource === "snapshot") livePriced = false;
    for (let index = 0; index < positionMetrics.pnlLots.length; index++) {
      const lot = positionMetrics.pnlLots[index]!;
      const value = freshQuote ? Math.abs(lot.priceUnits) * currentUnitPrice : Number.NaN;
      if (!Number.isFinite(value)) {
        livePriced = false;
        continue;
      }
      pricedLots.push({
        key: `${ticker.metadata.ticker}:${index}`,
        direction: lot.direction,
        value,
        brokerValue: lot.brokerMarketValue !== null && Number.isFinite(lot.brokerMarketValue) ? lot.brokerMarketValue : null,
      });
    }

    const marketValue = resolvePortfolioMarketValue(positionMetrics, currentUnitPrice);
    allocationHoldings.push({
      symbol: ticker.metadata.ticker,
      held: true,
      marketValue: marketValue?.net ?? null,
      units: positionMetrics.totalShares,
      unitPrice: currentUnitPrice,
    });
    if (marketValue) {
      totalMktValue += marketValue.gross;
      netMktValue += marketValue.net;
      if (activeQuote && Number.isFinite(grossPriceUnits)) {
        // A listing that no longer trades does not move: its last session's change is not today's.
        const previousClose = quote?.delisting ? activeQuote.price
          : activeQuote.change != null ? activeQuote.price - activeQuote.change : Number.NaN;
        // A future's notional is no money held: the currency moves its P&L alone, never the contract's value.
        const currencyMoves = !positionMetrics.isFuture && fxMove(quoteCurrency) != null;
        totalPrevValue += currencyMoves ? toBaseBefore(grossPriceUnits * previousClose, quoteCurrency) : toBaseQuote(grossPriceUnits * previousClose);
        signedDailyPnl += currencyMoves
          ? toBaseQuote(totalPriceUnits * activeQuote.price) - toBaseBefore(totalPriceUnits * previousClose, quoteCurrency)
          : toBaseQuote(totalPriceUnits * (activeQuote.price - previousClose));
        // The move valued: the latest print's from the daily reference, the regular close's from the session before it.
        if (!quote?.delisting) {
          dayBases.push(quoteChangeBasis(quote, {
            session: valuationBasis === "regular-close" ? "regular" : "active",
            terms,
          }));
          dayPrints.push(valuationBasis === "latest-print" ? extendedPrintSession(quote, activeQuote.price) : null);
        }
      } else {
        // A broker mark is not evidence of an unchanged day.
        signedDailyPnl = Number.NaN;
        totalPrevValue = Number.NaN;
      }
    } else {
      unavailableSymbols.add(ticker.metadata.ticker);
      totalMktValue = netMktValue = totalPrevValue = signedDailyPnl = Number.NaN;
    }
  }

  // Each lot adds its value to gross and its signed value to net, so the longs are half their sum and the shorts half their difference.
  const longMktValue = (totalMktValue + netMktValue) / 2;
  const shortMktValue = (netMktValue - totalMktValue) / 2;
  const dailyPnl = signedDailyPnl;
  const dailyPnlPct = totalPrevValue !== 0 ? (dailyPnl / totalPrevValue) * 100 : 0;
  const unrealizedPnl = signedUnrealizedPnl;
  const unrealizedPnlPct = portfolioPnlPercent(unrealizedPnl, totalCostBasis) ?? Number.NaN;
  const avgWatchlistChange = watchlistCount > 0 ? watchlistChangeSum / watchlistCount : 0;
  const dayChangeBasis = dayMoveBasisLabel(dayBases, dayPrints, { marks: true, now });

  return {
    totalMktValue,
    netMktValue,
    longMktValue,
    shortMktValue,
    hasShorts,
    ...(hasFutures ? { hasFutures } : {}),
    ...(unknownContractSizeSymbols.size ? { unknownContractSizeSymbols: [...unknownContractSizeSymbols].sort() } : {}),
    ...(unavailableSymbols.size ? { unavailableSymbols: [...unavailableSymbols].sort() } : {}),
    ...(unavailableCostSymbols.size ? { unavailableCostSymbols: [...unavailableCostSymbols].sort() } : {}),
    ...(brokerPnlSymbols.size ? { brokerPnlSymbols: [...brokerPnlSymbols].sort() } : {}),
    unrealizedPnlBasis: !Number.isFinite(unrealizedPnl) || pnlBases.size === 0 ? "unavailable"
      : pnlBases.size > 1 ? "mixed" : [...pnlBases][0],
    dailyPnl,
    dailyPnlPct,
    ...(dayChangeBasis ? { dayChangeBasis } : {}),
    ...(dayChangeBasis && dayPrints.some((print) => print != null) ? { dayAtExtendedPrint: true } : {}),
    totalCostBasis,
    hasPositions,
    unrealizedPnl,
    unrealizedPnlPct,
    avgWatchlistChange,
    watchlistCount,
    ...(unavailableConversions.size > 0 ? { unavailableConversions: [...unavailableConversions].sort() } : {}),
    ...(isPortfolio ? { livePriced: hasPositions && livePriced } : {}),
    ...(pricedLots.length > 0 ? { pricedLots } : {}),
    ...(isPortfolio ? { allocationHoldings } : {}),
  };
}
