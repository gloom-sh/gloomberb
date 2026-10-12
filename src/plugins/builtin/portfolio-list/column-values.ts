// Public API: gloomberb/components re-exports getColumnValue, getSortValue and
// ColumnContext from here, so external plugins depend on their names and shapes.
import { comparablePriceEarnings, formatPriceEarnings } from "../../../utils/price-earnings";
import { convertMarketCapitalization, listedMarketCapitalization } from "../../../utils/market-capitalization";
import type { ColumnConfig } from "../../../types/config";
import type { AnalystResearchData, CorporateActionsData, MarketState, TickerFinancials } from "../../../types/financials";
import type { EarningsEvent } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { colors, priceColor } from "../../../theme/colors";
import { formatQuoteAgeWithSource, resolveQuoteAgeTimestamp } from "../../../market-data/quotes/time";
import { formatFeedTime, formatShortDate, parseDisplayDate, type ShortDateOptions } from "../../../utils/datetime-format";
import { convertCurrency, formatCompact, formatCompactAmount, formatNumber, formatPercentRaw } from "../../../utils/format";
import {
  formatMarketCost,
  quoteFormatOptions,
  formatMarketPrice,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
  formatSignedMarketPrice,
  withCurrencyMinorDigits,
  withStablePriceDigits,
  type MarketFormatOptions,
} from "../../../market-data/market/format";
import {
  getActiveQuoteDisplay,
  getCompletedRegularSessionDisplay,
  getExtendedSessionDisplay,
  marketChangeColor,
  marketPriceColor,
  marketStateDot,
  type ActiveQuoteDisplay,
} from "../../../market-data/market/status";
import { formatOptionTicker } from "../../../utils/options";
import { classifyInstrumentType } from "../../../tickers/instrument-kind";
import { perpetualDisplaySymbol, perpetualListing } from "../../../tickers/perpetual-listing";
import { currentListingName } from "../../../tickers/listing-name";
import { PRICE_SPARKLINE_COLUMN_ID } from "../../../components/price-sparkline/view";
import { followLiveSparklinePrice, resolveSparklineHistory, sparklineValues } from "../../../components/price-sparkline/model";
import {
  liveDividendYield,
  liveFiftyTwoWeekRange,
  liveForwardPE,
  liveMarketCapitalization,
  liveTrailingPE,
  targetReferencePrice,
} from "./live-valuation";
import {
  getPortfolioPositionMetrics,
  getPortfolioQuoteDisplay,
  resolvePortfolioMarketValue,
  resolvePortfolioPositionPnl,
  portfolioPnlPercent,
  signedPositionDirection,
  type PortfolioPositionPnl,
} from "../../../portfolio/position-metrics";
import {
  getPortfolioValuationDisplay,
  getPortfolioValuationTime,
  type PortfolioValuationBasis,
} from "../../../portfolio/valuation-basis";
import { isFiniteNumber } from "../../../utils/guards";
import {
  allocationFigures,
  formatAllocationDrift,
  formatAllocationWeight,
  formatTradeUnits,
  holdingTarget,
  type AllocationFigures,
} from "./allocation";

export interface ColumnContext {
  activeTab?: string;
  /** Money columns convert into this: a portfolio's totals currency, else the base currency. */
  baseCurrency: string;
  exchangeRates: Map<string, number>;
  /** Clock for quote age (per second while shown) and day-based columns. */
  now: number;
  /** What market values, P&L, weights and the day's move are priced at; the latest print when absent. */
  valuationBasis?: PortfolioValuationBasis;
  /**
   * The total a portfolio's weights divide by: its priced holdings at net
   * market value plus its cash (see allocation.ts). It may trail the rows by
   * about a second.
   */
  portfolioTotalMarketValue?: number;
  /** The portfolio's target weights in percent, by symbol. */
  portfolioTargets?: Readonly<Record<string, number>>;
  supplementalVersion?: number;
  analystResearch?: Map<string, AnalystResearchData | null>;
  corporateActions?: Map<string, CorporateActionsData | null>;
  earningsEvents?: Map<string, EarningsEvent | null>;
  /** Each row's stock perpetual by ticker, null for none; a row is missing while its lookup loads. */
  perpetuals?: ReadonlyMap<string, ListedPerpetual | null>;
  /** Moves whenever `perpetuals` does. */
  perpetualsVersion?: number;
}

/** A row's stock perpetual as PERP% and FUND 8H read it; rates are fractions. */
interface ListedPerpetual {
  marketId: string;
  /** The mark over the stock's last price; null without a comparable reference. */
  underlyingPremium: number | null;
  /** Funding per eight hours, whatever interval the venue pays on. */
  fundingRate8h: number | null;
  /** The venue's latest reading is old. */
  stale: boolean;
}

/** The two perpetual columns: what each reads from the row's contract. */
const PERPETUAL_FIELDS = { perp_premium: "underlyingPremium", perp_funding: "fundingRate8h" } as const;

/** A perpetual's rate in percent: two decimals for a premium, four for funding, as PERP shows them. */
export function formatPerpetualRate(value: number, decimals: number): string {
  const fixed = Math.abs(value * 100).toFixed(decimals);
  return `${/[1-9]/.test(fixed) ? (value > 0 ? "+" : "-") : ""}${fixed}%`;
}

function perpetualValue(columnId: keyof typeof PERPETUAL_FIELDS, symbol: string, ctx: ColumnContext): { pending: boolean; data: ListedPerpetual | null; value: number | null } {
  const perp = mapData(ctx.perpetuals, symbol);
  return { ...perp, value: perp.data?.[PERPETUAL_FIELDS[columnId]] ?? null };
}

/** Position and calendar dates as "Jan 5", read in UTC. */
const MONTH_DAY: ShortDateOptions = { year: false, utc: true, fallback: "\u2014" };

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysSince(value: Date | string | number | null | undefined, now: number): number | null {
  const date = parseDisplayDate(value);
  if (!date) return null;
  const days = Math.floor((startOfUtcDay(new Date(now)) - startOfUtcDay(date)) / 86_400_000);
  return days >= 0 ? days : null;
}

function formatHeldDays(days: number | null): string {
  if (days == null) return "—";
  if (days < 365) return `${days}d`;
  return `${formatNumber(days / 365, 1)}y`;
}

function activePositions(ticker: TickerRecord, activeTab: string | undefined): TickerRecord["metadata"]["positions"] {
  return activeTab
    ? ticker.metadata.positions.filter((position) => position.portfolio === activeTab)
    : ticker.metadata.positions;
}

function earliestDateAcquired(ticker: TickerRecord, activeTab: string | undefined): Date | null {
  return activePositions(ticker, activeTab)
    .map((position) => parseDisplayDate(position.dateAcquired))
    .filter((date): date is Date => date != null)
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
}

function positionSideLabel(ticker: TickerRecord, activeTab: string | undefined): string | null {
  const positions = activePositions(ticker, activeTab);
  if (positions.length === 0) return null;
  const shortCount = positions.filter((position) => signedPositionDirection(position) < 0).length;
  if (shortCount === 0) return "LONG";
  if (shortCount === positions.length) return "SHORT";
  return "MIX";
}

function compactText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

function targetValue(data: AnalystResearchData | null | undefined): number | null {
  const target = data?.priceTarget;
  return target?.average ?? target?.median ?? target?.high ?? target?.low ?? null;
}

function mapData<T>(map: ReadonlyMap<string, T | null> | undefined, symbol: string): { pending: boolean; data: T | null } {
  if (!map) return { pending: false, data: null };
  if (!map.has(symbol)) return { pending: true, data: null };
  return { pending: false, data: map.get(symbol) ?? null };
}

function futureOrLatestDate<T>(
  values: readonly T[],
  getDate: (value: T) => string | Date | number | null | undefined,
  now: number,
): Date | null {
  const dates = values
    .map(getDate)
    .map(parseDisplayDate)
    .filter((date): date is Date => date != null)
    .sort((left, right) => left.getTime() - right.getTime());
  if (dates.length === 0) return null;
  const today = startOfUtcDay(new Date(now));
  return dates.find((date) => startOfUtcDay(date) >= today) ?? dates.at(-1) ?? null;
}

function nextEarningsDate(symbol: string, ctx: ColumnContext): { pending: boolean; date: Date | null } {
  const event = mapData(ctx.earningsEvents, symbol);
  if (event.pending) return { pending: true, date: null };
  if (event.data) return { pending: false, date: event.data.earningsDate };

  const actions = mapData(ctx.corporateActions, symbol);
  if (actions.pending) return { pending: true, date: null };
  return {
    pending: false,
    date: futureOrLatestDate(actions.data?.earnings ?? [], (earning) => earning.date, ctx.now),
  };
}

function exDividendDate(symbol: string, ctx: ColumnContext): { pending: boolean; date: Date | null } {
  const actions = mapData(ctx.corporateActions, symbol);
  if (actions.pending) return { pending: true, date: null };
  return {
    pending: false,
    date: futureOrLatestDate(actions.data?.dividends ?? [], (dividend) => dividend.exDate, ctx.now),
  };
}

/** LAST, CHG and quote-derived columns show the traded price; positions in
 * options are valued at their mark (see getPortfolioQuoteDisplay). */
function tradedQuoteDisplay(
  metrics: ReturnType<typeof getPortfolioPositionMetrics>,
  valuation: ActiveQuoteDisplay | null,
  quote: TickerFinancials["quote"],
): ActiveQuoteDisplay | null {
  return valuation && metrics.valuesAtMark ? getActiveQuoteDisplay(quote) : valuation;
}

/**
 * LAST, CHG and CHG% once the regular session is over, and in the pre-market
 * while the quote carries the last session's close and move: that close and its
 * move, frozen, because the EXT% column carries the extended print measured
 * from that close. Until the close, and wherever no close is reported (a
 * pre-market quote without it, venues without extended hours), the traded price
 * as above.
 * Valuation columns (DAY P&L, MKT VAL, weight, P&L) keep the latest print,
 * unless the pane values at the regular close, which is this headline.
 * A watchlist's Avg Day averages this CHG%.
 */
export function headlineQuoteDisplay(
  traded: ActiveQuoteDisplay | null,
  quote: TickerFinancials["quote"],
): ActiveQuoteDisplay | null {
  return traded ? getCompletedRegularSessionDisplay(quote) ?? traded : null;
}

/** CHG% as shown: the headline's, else the quote's own when no position price is usable. */
function headlineChangePercent(
  headline: ActiveQuoteDisplay | null,
  quote: TickerFinancials["quote"],
): number | undefined {
  if (headline) return headline.changePercent;
  return quote ? (getCompletedRegularSessionDisplay(quote) ?? quote).changePercent : undefined;
}

function fiftyTwoWeekPosition(displayQuote: ActiveQuoteDisplay | null, quote: TickerFinancials["quote"]): number | null {
  const range = displayQuote ? liveFiftyTwoWeekRange(quote, displayQuote.price) : null;
  return displayQuote && range ? ((displayQuote.price - range.low) / (range.high - range.low)) * 100 : null;
}

/** The row's weight, target, drift and trade, from its own live value and the pane's total. */
function rowAllocation(
  ticker: TickerRecord,
  activeQuote: ActiveQuoteDisplay | null,
  baseMetrics: ReturnType<typeof getPortfolioPositionMetrics>,
  toBaseQuote: (value: number) => number,
  ctx: ColumnContext,
): AllocationFigures & { unpriced: boolean } {
  const held = baseMetrics.positionCount > 0;
  const unitPrice = activeQuote ? toBaseQuote(activeQuote.price) : null;
  const marketValue = held ? resolvePortfolioMarketValue(baseMetrics, unitPrice)?.net ?? null : 0;
  return {
    ...allocationFigures(
      { held, marketValue, units: baseMetrics.totalShares, unitPrice },
      ctx.portfolioTotalMarketValue,
      holdingTarget(ctx.portfolioTargets, ticker.metadata.ticker),
    ),
    unpriced: held && marketValue == null,
  };
}

/** A held position without a price says so where its allocation would be. */
const UNPRICED = "n/a";

/**
 * The symbol the Ticker column shows after its market-state dot: an option reads as its contract (`AAPL C $300
 * Dec'26`, from an OCC code or a broker's symbol), a perpetual as its venue writes it (`BZUSDT`, `xyz:BRENTOIL`),
 * the venue being its exchange.
 */
export function tickerDisplayName(ticker: TickerRecord): string {
  if (classifyInstrumentType(ticker.metadata.assetCategory) === "option") return formatOptionTicker(ticker.metadata.ticker);
  const perpetual = perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange);
  return perpetual ? perpetualDisplaySymbol(perpetual) : ticker.metadata.ticker;
}

export function resolvePortfolioPriceValue(
  activeQuote: ActiveQuoteDisplay | null,
  brokerMarkPrice: number | undefined,
  formatOptions: MarketFormatOptions = {},
  maxWidth?: number,
  marketState?: MarketState,
): { text: string; color?: string } {
  if (activeQuote) {
    return {
      text: formatMarketPrice(activeQuote.price, { ...formatOptions, maxWidth }),
      color: marketPriceColor(activeQuote.change, marketState),
    };
  }
  if (brokerMarkPrice != null) {
    return { text: formatMarketPrice(brokerMarkPrice, { ...formatOptions, maxWidth }) };
  }
  return { text: "—" };
}

export function getColumnValue(
  col: ColumnConfig,
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  ctx: ColumnContext,
): { text: string; color?: string; value?: number | null; pnlBasis?: PortfolioPositionPnl["basis"] } {
  const quote = financials?.quote;

  const fundamentals = financials?.fundamentals;
  const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

  const positionMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency, undefined, quote);
  // The latest print, which the quote columns read, and the price the position is valued at.
  const liveQuote = getPortfolioQuoteDisplay(positionMetrics, quote);
  const activeQuote = getPortfolioValuationDisplay(positionMetrics, quote, ctx.valuationBasis);
  const displayQuote = tradedQuoteDisplay(positionMetrics, liveQuote, quote);
  const headlineQuote = headlineQuoteDisplay(displayQuote, quote);
  const { positionCurrency, totalShares, totalCost, totalCostUnits, totalPriceUnits, multiplierHint, brokerMarkPrice } = positionMetrics;
  const baseMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency, {
    currency: ctx.baseCurrency,
    convert: (value, currency) => convertCurrency(value, currency, ctx.baseCurrency, ctx.exchangeRates),
  }, quote);

  const toBaseQuote = (value: number) =>
    convertCurrency(value, quoteCurrency, ctx.baseCurrency, ctx.exchangeRates);
  const positionPnl = resolvePortfolioPositionPnl(baseMetrics,
    activeQuote ? toBaseQuote(activeQuote.price) : null);
  const formatOptions: MarketFormatOptions = {
    assetCategory: ticker.metadata.assetCategory,
    multiplier: multiplierHint,
    priceBasis: positionMetrics.priceBasis,
  };
  // Streamed prices keep one decimal count per instrument, so a tick landing on
  // a whole dime does not print 150.1 and jump the column's digits.
  const currentQuoteOptions = withStablePriceDigits(
    { ...formatOptions, ...quoteFormatOptions(quote, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType) },
    quoteCurrency,
    quote,
  );
  const markOptions = withStablePriceDigits(formatOptions, positionCurrency || quoteCurrency, { price: brokerMarkPrice });

  switch (col.id) {
    case "ticker": {
      const marketState = quote?.marketState;
      const statusDot = marketStateDot(marketState);
      return { text: `${statusDot} ${tickerDisplayName(ticker)}` };
    }
    case "name":
      // The name the listing's quote gives now, as `quote` and `portfolio show` name it, else the saved one.
      return { text: compactText(currentListingName(ticker, quote) || ticker.metadata.name || quote?.name) };
    case "asset_type":
      return { text: compactText(ticker.metadata.assetCategory) };
    case "exchange":
      return {
        text: compactText(
          // A row saved as 247540:KRX shows KOSDAQ, the board its quote is read on.
          quote?.tradingExchangeName
          || quote?.listingExchangeName
          || quote?.exchangeName
          || quote?.routingExchangeName
          || ticker.metadata.exchange,
        ),
      };
    case "currency":
      return { text: compactText((positionCurrency || quoteCurrency || ticker.metadata.currency || "").toUpperCase()) };
    case "sector":
      return { text: compactText(ticker.metadata.sector || financials?.profile?.sector) };
    case "industry":
      return { text: compactText(ticker.metadata.industry || financials?.profile?.industry) };
    case "tags":
      return { text: ticker.metadata.tags.length > 0 ? ticker.metadata.tags.join(",") : "—" };
    case "price":
      return resolvePortfolioPriceValue(headlineQuote, brokerMarkPrice, headlineQuote ? currentQuoteOptions : markOptions, col.width, quote?.marketState);
    case "change":
      if (!headlineQuote) return { text: "—" };
      return {
        text: formatSignedMarketPrice(headlineQuote.change, { ...currentQuoteOptions, maxWidth: col.width }),
        color: marketChangeColor(headlineQuote.change, quote?.marketState),
      };
    case "bid":
      return { text: quote?.bid != null ? formatMarketPrice(quote.bid, { ...currentQuoteOptions, maxWidth: col.width }) : "—" };
    case "ask":
      return { text: quote?.ask != null ? formatMarketPrice(quote.ask, { ...currentQuoteOptions, maxWidth: col.width }) : "—" };
    case "spread":
      return {
        text: quote?.bid != null && quote?.ask != null
          ? formatMarketPrice(quote.ask - quote.bid, { ...currentQuoteOptions, maxWidth: col.width })
          : "—",
      };
    case "spread_pct": {
      if (!isFiniteNumber(quote?.bid) || !isFiniteNumber(quote?.ask)) return { text: "—" };
      const midpoint = (quote.bid + quote.ask) / 2;
      if (midpoint === 0) return { text: "—" };
      return { text: formatPercentRaw(((quote.ask - quote.bid) / Math.abs(midpoint)) * 100) };
    }
    case "bid_ask_size": {
      if (!isFiniteNumber(quote?.bidSize) && !isFiniteNumber(quote?.askSize)) return { text: "—" };
      return { text: `${formatCompact(quote?.bidSize)}/${formatCompact(quote?.askSize)}` };
    }
    case "change_pct": {
      const changePercent = headlineChangePercent(headlineQuote, quote);
      return quote
        ? { text: formatPercentRaw(changePercent), color: marketChangeColor(changePercent, quote.marketState) }
        : { text: "—" };
    }
    case "volume":
      return { text: isFiniteNumber(quote?.volume) ? formatCompact(quote.volume, { fixedDecimals: true }) : "—" };
    case "dollar_volume": {
      if (!displayQuote || !isFiniteNumber(quote?.volume)) return { text: "—" };
      return { text: formatCompact(toBaseQuote(displayQuote.price * quote.volume), { fixedDecimals: true }) };
    }
    case "range_52w": {
      const position = fiftyTwoWeekPosition(displayQuote, quote);
      return { text: position == null ? "—" : formatPercentRaw(Math.max(0, Math.min(100, position))) };
    }
    case "market_cap": {
      const cap = liveMarketCapitalization(quote, fundamentals);
      const value = cap ? listedMarketCapitalization(convertMarketCapitalization(cap.value, cap.currency, ctx.baseCurrency, ctx.exchangeRates)) : null;
      return { text: value == null ? "—" : formatCompact(value, { fixedDecimals: true }) };
    }
    case "pe":
      return { text: formatPriceEarnings(liveTrailingPE(quote, fundamentals)) };
    case "forward_pe":
      return { text: formatPriceEarnings(liveForwardPE(quote, fundamentals)) };
    case "dividend_yield": {
      const dividendYield = liveDividendYield(quote, fundamentals);
      return { text: dividendYield != null ? `${(dividendYield * 100).toFixed(2)}%` : "—" };
    }
    case "ext_hours": {
      const changePercent = getExtendedSessionDisplay(quote)?.changePercent;
      if (!isFiniteNumber(changePercent)) return { text: "—" };
      return { text: formatPercentRaw(changePercent), color: priceColor(changePercent) };
    }
    case "side":
      return { text: positionSideLabel(ticker, ctx.activeTab) ?? "—" };
    case "shares":
      return { text: positionMetrics.positionCount > 0 ? formatMarketQuantity(totalShares, { ...formatOptions, maxWidth: col.width }) : "—" };
    case "avg_cost":
      if (totalCostUnits === 0 || !Number.isFinite(totalCost)) return { text: "—" };
      // A money cost keeps its currency's minor unit, as `portfolio show` prints it: 45.50, not 45.5.
      return { text: formatMarketCost(totalCost / Math.abs(totalCostUnits), { ...withCurrencyMinorDigits(formatOptions, positionCurrency), maxWidth: col.width }) };
    case "cost_basis":
      if (baseMetrics.positionCount === 0 || !Number.isFinite(baseMetrics.totalCost)) return { text: "—" };
      return { text: formatCompact(baseMetrics.totalCost) };
    case "mkt_value": {
      if (baseMetrics.positionCount === 0) return { text: "—" };
      const marketValue = resolvePortfolioMarketValue(baseMetrics, activeQuote ? toBaseQuote(activeQuote.price) : null)?.gross;
      return { text: marketValue == null ? UNPRICED : formatCompactAmount(marketValue) };
    }
    case "weight": {
      const allocation = rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx);
      return { text: allocation.unpriced ? UNPRICED : formatAllocationWeight(allocation.weight) };
    }
    case "target_weight":
      return { text: formatAllocationWeight(holdingTarget(ctx.portfolioTargets, ticker.metadata.ticker)) };
    case "drift": {
      const allocation = rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx);
      if (allocation.unpriced && allocation.targetWeight != null) return { text: UNPRICED };
      const text = formatAllocationDrift(allocation.drift);
      return { text, color: /[1-9]/.test(text) ? priceColor(allocation.drift!) : undefined };
    }
    case "trade": {
      const allocation = rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx);
      if (allocation.unpriced && allocation.targetWeight != null) return { text: UNPRICED };
      const text = formatTradeUnits(allocation.tradeUnits, { units: totalShares, assetCategory: ticker.metadata.assetCategory });
      // The cell shows the trade rounded; exports and rendered-view reports keep the full figure.
      return { text, value: allocation.tradeUnits, color: /[1-9]/.test(text) ? priceColor(allocation.tradeUnits!) : undefined };
    }
    case "trade_value": {
      const allocation = rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx);
      if (allocation.unpriced && allocation.targetWeight != null) return { text: UNPRICED };
      const text = formatCompactAmount(allocation.tradeValue ?? undefined, { signed: true });
      return { text, color: /[1-9]/.test(text) ? priceColor(allocation.tradeValue!) : undefined };
    }
    case "day_pnl":
      if (activeQuote && isFiniteNumber(activeQuote.change) && Number.isFinite(positionMetrics.grossPriceUnits) && positionMetrics.grossPriceUnits !== 0) {
        const dayPnl = toBaseQuote(totalPriceUnits * activeQuote.change);
        return { text: formatCompactAmount(dayPnl, { signed: true }), color: priceColor(dayPnl) };
      }
      return { text: "—" };
    case "pnl": {
      const pnl = positionPnl.value;
      return pnl === null ? { text: "—", pnlBasis: positionPnl.basis }
        : { text: formatCompactAmount(pnl, { signed: true }), color: priceColor(pnl), pnlBasis: positionPnl.basis };
    }
    case "pnl_pct": {
      const percent = portfolioPnlPercent(positionPnl.value, baseMetrics.totalCost);
      return percent === null ? { text: "—" } : { text: formatPercentRaw(percent), color: priceColor(percent) };
    }
    case "mark_delta":
      if (!liveQuote || brokerMarkPrice == null || liveQuote.price === 0 || positionMetrics.priceBasis !== (quote?.priceBasis ?? "per-unit") || positionCurrency !== quoteCurrency) return { text: "—" };
      {
        const percent = ((brokerMarkPrice - liveQuote.price) / Math.abs(liveQuote.price)) * 100;
        return { text: formatPercentRaw(percent), color: priceColor(percent) };
      }
    case "acq_date": {
      return { text: formatShortDate(earliestDateAcquired(ticker, ctx.activeTab), MONTH_DAY) };
    }
    case "held": {
      return { text: formatHeldDays(daysSince(earliestDateAcquired(ticker, ctx.activeTab), ctx.now)) };
    }
    case "target": {
      const analyst = mapData(ctx.analystResearch, ticker.metadata.ticker);
      if (analyst.pending) return { text: "…" };
      const value = targetValue(analyst.data);
      const currency = analyst.data?.priceTarget?.currency ?? analyst.data?.currency ?? quoteCurrency;
      return {
        text: value == null
          ? "—"
          : formatMarketPriceWithCurrency(value, currency, { ...formatOptions, maxWidth: col.width }),
      };
    }
    case "target_pct": {
      const analyst = mapData(ctx.analystResearch, ticker.metadata.ticker);
      if (analyst.pending) return { text: "…" };
      const value = targetValue(analyst.data);
      const current = targetReferencePrice(analyst.data, quoteCurrency, displayQuote?.price);
      if (value == null || !current) return { text: "—" };
      const percent = ((value - current) / Math.abs(current)) * 100;
      return { text: formatPercentRaw(percent), color: priceColor(percent) };
    }
    case "rating": {
      const analyst = mapData(ctx.analystResearch, ticker.metadata.ticker);
      if (analyst.pending) return { text: "…" };
      return { text: analyst.data?.recommendationRating != null ? formatNumber(analyst.data.recommendationRating, 1) : "—" };
    }
    case "ex_div": {
      const result = exDividendDate(ticker.metadata.ticker, ctx);
      if (result.pending) return { text: "…" };
      return { text: formatShortDate(result.date, MONTH_DAY) };
    }
    case "next_earn": {
      const result = nextEarningsDate(ticker.metadata.ticker, ctx);
      if (result.pending) return { text: "…" };
      return { text: formatShortDate(result.date, MONTH_DAY) };
    }
    case "perp_premium":
    case "perp_funding": {
      const perp = perpetualValue(col.id, ticker.metadata.ticker, ctx);
      if (perp.pending) return { text: "…" };
      if (perp.value == null) return { text: "—" };
      // An old venue reading keeps its figure, dimmed, as PERP shows a stale market.
      return {
        text: formatPerpetualRate(perp.value, col.id === "perp_funding" ? 4 : 2),
        color: perp.data?.stale ? colors.textDim : priceColor(perp.value),
      };
    }
    case "latency":
      return { text: formatQuoteAgeWithSource(quote, ctx.now, { seconds: true }) };
    case "as_of": {
      const time = getPortfolioValuationTime(quote, ctx.valuationBasis, positionMetrics);
      if (!time) return { text: "—" };
      // In UTC, as the header says; a close the venue's calendar gives no hour for is dated by its day.
      return { text: time.dateOnly ? formatShortDate(time.time, MONTH_DAY) : formatFeedTime(time.time, ctx.now, "—", { utc: true }) };
    }
    case PRICE_SPARKLINE_COLUMN_ID:
      return { text: "" };
    default:
      return { text: "—" };
  }
}

export function getSortValue(
  col: ColumnConfig,
  ticker: TickerRecord,
  financials: TickerFinancials | undefined,
  ctx: ColumnContext,
): number | string | null {
  const quote = financials?.quote;

  const fundamentals = financials?.fundamentals;
  const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

  const positionMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency, undefined, quote);
  const liveQuote = getPortfolioQuoteDisplay(positionMetrics, quote);
  const activeQuote = getPortfolioValuationDisplay(positionMetrics, quote, ctx.valuationBasis);
  const displayQuote = tradedQuoteDisplay(positionMetrics, liveQuote, quote);
  const headlineQuote = headlineQuoteDisplay(displayQuote, quote);
  const { positionCurrency, totalShares, totalCost, totalCostUnits, totalPriceUnits, brokerMarkPrice } = positionMetrics;
  const baseMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency, {
    currency: ctx.baseCurrency,
    convert: (value, currency) => convertCurrency(value, currency, ctx.baseCurrency, ctx.exchangeRates),
  }, quote);

  const toBaseQuote = (value: number) =>
    convertCurrency(value, quoteCurrency, ctx.baseCurrency, ctx.exchangeRates);
  const positionPnl = resolvePortfolioPositionPnl(baseMetrics,
    activeQuote ? toBaseQuote(activeQuote.price) : null);

  switch (col.id) {
    case "ticker":
      return ticker.metadata.ticker;
    case "name":
      return currentListingName(ticker, quote) || ticker.metadata.name || quote?.name || null;
    case "asset_type":
      return ticker.metadata.assetCategory ?? null;
    case "exchange":
      return quote?.tradingExchangeName
        ?? quote?.listingExchangeName
        ?? quote?.exchangeName
        ?? quote?.routingExchangeName
        ?? ticker.metadata.exchange
        ?? null;
    case "currency":
      return (positionCurrency || quoteCurrency || ticker.metadata.currency || "").toUpperCase() || null;
    case "sector":
      return ticker.metadata.sector || financials?.profile?.sector || null;
    case "industry":
      return ticker.metadata.industry || financials?.profile?.industry || null;
    case "tags":
      return ticker.metadata.tags.join(",");
    case "price":
      if (headlineQuote) return headlineQuote.price;
      if (brokerMarkPrice != null) return brokerMarkPrice;
      return null;
    case "bid":
      return quote?.bid ?? null;
    case "ask":
      return quote?.ask ?? null;
    case "spread":
      return quote?.bid != null && quote?.ask != null ? quote.ask - quote.bid : null;
    case "spread_pct": {
      if (!isFiniteNumber(quote?.bid) || !isFiniteNumber(quote?.ask)) return null;
      const midpoint = (quote.bid + quote.ask) / 2;
      return midpoint !== 0 ? ((quote.ask - quote.bid) / Math.abs(midpoint)) * 100 : null;
    }
    case "bid_ask_size":
      return isFiniteNumber(quote?.bidSize) || isFiniteNumber(quote?.askSize)
        ? (quote?.bidSize ?? 0) + (quote?.askSize ?? 0)
        : null;
    case "change":
      return headlineQuote?.change ?? null;
    case "change_pct":
      return headlineChangePercent(headlineQuote, quote) ?? null;
    case "volume":
      return quote?.volume ?? null;
    case "dollar_volume":
      return displayQuote && isFiniteNumber(quote?.volume)
        ? toBaseQuote(displayQuote.price * quote.volume)
        : null;
    case "range_52w":
      return fiftyTwoWeekPosition(displayQuote, quote);
    case "market_cap": {
      const cap = liveMarketCapitalization(quote, fundamentals);
      return cap ? listedMarketCapitalization(convertMarketCapitalization(cap.value, cap.currency, ctx.baseCurrency, ctx.exchangeRates)) : null;
    }
    case "pe":
      return comparablePriceEarnings(liveTrailingPE(quote, fundamentals));
    case "forward_pe":
      return comparablePriceEarnings(liveForwardPE(quote, fundamentals));
    case "dividend_yield":
      return liveDividendYield(quote, fundamentals) ?? null;
    case "ext_hours":
      return getExtendedSessionDisplay(quote)?.changePercent ?? null;
    case "side":
      return positionSideLabel(ticker, ctx.activeTab);
    case "shares":
      return positionMetrics.positionCount > 0 ? totalShares : null;
    case "avg_cost":
      return positionMetrics.priceBasis !== null && totalCostUnits !== 0 && Number.isFinite(totalCost) ? totalCost / Math.abs(totalCostUnits) : null;
    case "cost_basis":
      return baseMetrics.positionCount > 0 && Number.isFinite(baseMetrics.totalCost) ? baseMetrics.totalCost : null;
    case "mkt_value":
      return resolvePortfolioMarketValue(baseMetrics, activeQuote ? toBaseQuote(activeQuote.price) : null)?.gross ?? null;
    case "weight":
      return rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx).weight;
    case "target_weight":
      return holdingTarget(ctx.portfolioTargets, ticker.metadata.ticker) ?? null;
    case "drift":
      return rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx).drift;
    case "trade":
      return rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx).tradeUnits;
    case "trade_value":
      return rowAllocation(ticker, activeQuote, baseMetrics, toBaseQuote, ctx).tradeValue;
    case "day_pnl":
      if (activeQuote && isFiniteNumber(activeQuote.change) && Number.isFinite(positionMetrics.grossPriceUnits) && positionMetrics.grossPriceUnits !== 0) {
        return toBaseQuote(totalPriceUnits * activeQuote.change);
      }
      return null;
    case "pnl":
      return positionPnl.value;
    case "pnl_pct":
      return portfolioPnlPercent(positionPnl.value, baseMetrics.totalCost);
    case "mark_delta":
      return liveQuote && brokerMarkPrice != null && liveQuote.price !== 0 && positionMetrics.priceBasis === (quote?.priceBasis ?? "per-unit") && positionCurrency === quoteCurrency
        ? ((brokerMarkPrice - liveQuote.price) / Math.abs(liveQuote.price)) * 100
        : null;
    case "acq_date":
      return earliestDateAcquired(ticker, ctx.activeTab)?.getTime() ?? null;
    case "held":
      return daysSince(earliestDateAcquired(ticker, ctx.activeTab), ctx.now);
    case "target": {
      const analyst = mapData(ctx.analystResearch, ticker.metadata.ticker);
      return analyst.pending ? null : targetValue(analyst.data);
    }
    case "target_pct": {
      const analyst = mapData(ctx.analystResearch, ticker.metadata.ticker);
      const value = analyst.pending ? null : targetValue(analyst.data);
      const current = targetReferencePrice(analyst.data, quoteCurrency, displayQuote?.price);
      return value != null && current ? ((value - current) / Math.abs(current)) * 100 : null;
    }
    case "rating": {
      const analyst = mapData(ctx.analystResearch, ticker.metadata.ticker);
      return analyst.pending ? null : analyst.data?.recommendationRating ?? null;
    }
    case "ex_div": {
      const result = exDividendDate(ticker.metadata.ticker, ctx);
      return result.pending ? null : result.date?.getTime() ?? null;
    }
    case "next_earn": {
      const result = nextEarningsDate(ticker.metadata.ticker, ctx);
      return result.pending ? null : result.date?.getTime() ?? null;
    }
    case "perp_premium":
    case "perp_funding":
      return perpetualValue(col.id, ticker.metadata.ticker, ctx).value;
    case "latency":
      return quote ? ctx.now - (resolveQuoteAgeTimestamp(quote, ctx.now) ?? ctx.now) : null;
    case "as_of":
      return getPortfolioValuationTime(quote, ctx.valuationBasis, positionMetrics)?.time ?? null;
    case PRICE_SPARKLINE_COLUMN_ID: {
      // The trend the sparkline draws: its window, closed by the live price.
      const history = followLiveSparklinePrice(financials?.priceHistory ?? [], quote, {
        assetCategory: quote?.instrumentType ?? ticker.metadata.assetCategory,
      });
      const values = sparklineValues(resolveSparklineHistory(history));
      const first = values[0];
      const last = values.at(-1);
      return first != null && last != null && first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
    }
    default:
      return null;
  }
}
