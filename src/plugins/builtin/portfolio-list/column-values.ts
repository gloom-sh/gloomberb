import { comparablePriceEarnings, formatPriceEarnings } from "../../../utils/price-earnings";
import { convertMarketCapitalization } from "../../../utils/market-capitalization";
import type { ColumnConfig } from "../../../types/config";
import type { AnalystResearchData, CorporateActionsData, MarketState, TickerFinancials } from "../../../types/financials";
import type { EarningsEvent } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { priceColor } from "../../../theme/colors";
import { formatQuoteAgeWithSource, resolveQuoteAgeTimestamp } from "../../../market-data/quotes/time";
import { convertCurrency, formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";
import {
  formatMarketCost,
  quoteFormatOptions,
  formatMarketPrice,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
  formatSignedMarketPrice,
  type MarketFormatOptions,
} from "../../../market-data/market/format";
import {
  getActiveQuoteDisplay,
  marketChangeColor,
  marketPriceColor,
  marketStateDot,
  type ActiveQuoteDisplay,
} from "../../../market-data/market/status";
import { formatOptionTicker } from "../../../utils/options";
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
} from "./position-metrics";

export interface ColumnContext {
  activeTab?: string;
  baseCurrency: string;
  exchangeRates: Map<string, number>;
  /** Clock for quote age (per second while shown) and day-based columns. */
  now: number;
  /** Gross market value of the collection; weights may trail it by about a second. */
  portfolioTotalMarketValue?: number;
  supplementalVersion?: number;
  analystResearch?: Map<string, AnalystResearchData | null>;
  corporateActions?: Map<string, CorporateActionsData | null>;
  earningsEvents?: Map<string, EarningsEvent | null>;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseDateValue(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatShortDate(value: Date | string | number | null | undefined): string {
  const date = parseDateValue(value);
  if (!date) return "—";
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function daysSince(value: Date | string | number | null | undefined, now: number): number | null {
  const date = parseDateValue(value);
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
    .map((position) => parseDateValue(position.dateAcquired))
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

function mapData<T>(map: Map<string, T | null> | undefined, symbol: string): { pending: boolean; data: T | null } {
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
    .map(parseDateValue)
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

function fiftyTwoWeekPosition(displayQuote: ActiveQuoteDisplay | null, quote: TickerFinancials["quote"]): number | null {
  const range = displayQuote ? liveFiftyTwoWeekRange(quote, displayQuote.price) : null;
  return displayQuote && range ? ((displayQuote.price - range.low) / (range.high - range.low)) * 100 : null;
}

function getActiveMarketValue(
  activeQuote: ActiveQuoteDisplay | null,
  positionMetrics: ReturnType<typeof getPortfolioPositionMetrics>,
  toBaseQuote: (value: number) => number,
): number | null {
  return resolvePortfolioMarketValue(positionMetrics, activeQuote ? toBaseQuote(activeQuote.price) : null)?.gross ?? null;
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
): { text: string; color?: string; pnlBasis?: PortfolioPositionPnl["basis"] } {
  const quote = financials?.quote;

  const fundamentals = financials?.fundamentals;
  const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

  const positionMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency, undefined, quote);
  const activeQuote = getPortfolioQuoteDisplay(positionMetrics, quote);
  const displayQuote = tradedQuoteDisplay(positionMetrics, activeQuote, quote);
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
  const currentQuoteOptions = { ...formatOptions, ...quoteFormatOptions(quote, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType) };

  switch (col.id) {
    case "ticker": {
      const marketState = quote?.marketState;
      const statusDot = marketStateDot(marketState);
      const displayName = ticker.metadata.assetCategory === "OPT"
        ? formatOptionTicker(ticker.metadata.ticker)
        : ticker.metadata.ticker;
      return { text: `${statusDot} ${displayName}` };
    }
    case "name":
      return { text: compactText(ticker.metadata.name || quote?.name) };
    case "asset_type":
      return { text: compactText(ticker.metadata.assetCategory) };
    case "exchange":
      return {
        text: compactText(
          quote?.listingExchangeName
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
      return resolvePortfolioPriceValue(displayQuote, brokerMarkPrice, displayQuote ? currentQuoteOptions : formatOptions, col.width, quote?.marketState);
    case "change":
      if (!displayQuote) return { text: "—" };
      return {
        text: formatSignedMarketPrice(displayQuote.change, { ...currentQuoteOptions, maxWidth: col.width }),
        color: marketChangeColor(displayQuote.change, quote?.marketState),
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
      if (!finiteNumber(quote?.bid) || !finiteNumber(quote?.ask)) return { text: "—" };
      const midpoint = (quote.bid + quote.ask) / 2;
      if (midpoint === 0) return { text: "—" };
      return { text: formatPercentRaw(((quote.ask - quote.bid) / Math.abs(midpoint)) * 100) };
    }
    case "bid_ask_size": {
      if (!finiteNumber(quote?.bidSize) && !finiteNumber(quote?.askSize)) return { text: "—" };
      return { text: `${formatCompact(quote?.bidSize)}/${formatCompact(quote?.askSize)}` };
    }
    case "change_pct":
      return displayQuote
        ? { text: formatPercentRaw(displayQuote.changePercent), color: marketChangeColor(displayQuote.changePercent, quote?.marketState) }
        : { text: quote ? formatPercentRaw(quote.changePercent) : "—", color: quote ? marketChangeColor(quote.changePercent, quote.marketState) : undefined };
    case "volume":
      return { text: finiteNumber(quote?.volume) ? formatCompact(quote.volume) : "—" };
    case "dollar_volume": {
      if (!displayQuote || !finiteNumber(quote?.volume)) return { text: "—" };
      return { text: formatCompact(toBaseQuote(displayQuote.price * quote.volume)) };
    }
    case "range_52w": {
      const position = fiftyTwoWeekPosition(displayQuote, quote);
      return { text: position == null ? "—" : formatPercentRaw(Math.max(0, Math.min(100, position))) };
    }
    case "market_cap": {
      const cap = liveMarketCapitalization(quote, fundamentals);
      const value = cap ? convertMarketCapitalization(cap.value, cap.currency, ctx.baseCurrency, ctx.exchangeRates) : null;
      return { text: value == null ? "—" : formatCompact(value) };
    }
    case "pe":
      return { text: formatPriceEarnings(liveTrailingPE(quote, fundamentals)) };
    case "forward_pe":
      return { text: formatPriceEarnings(liveForwardPE(quote, fundamentals)) };
    case "dividend_yield": {
      const dividendYield = liveDividendYield(quote, fundamentals);
      return { text: dividendYield != null ? `${(dividendYield * 100).toFixed(2)}%` : "—" };
    }
    case "ext_hours":
      if ((quote?.marketState === "PRE" || quote?.marketState === "PREPRE") && quote.preMarketPrice != null) {
        const changePercent = quote.preMarketChangePercent;
        if (!finiteNumber(changePercent)) return { text: "—" };
        return { text: formatPercentRaw(changePercent), color: priceColor(changePercent) };
      }
      if ((quote?.marketState === "POST" || quote?.marketState === "POSTPOST") && quote.postMarketPrice != null) {
        const changePercent = quote.postMarketChangePercent;
        if (!finiteNumber(changePercent)) return { text: "—" };
        return { text: formatPercentRaw(changePercent), color: priceColor(changePercent) };
      }
      return { text: "—" };
    case "side":
      return { text: positionSideLabel(ticker, ctx.activeTab) ?? "—" };
    case "shares":
      return { text: positionMetrics.positionCount > 0 ? formatMarketQuantity(totalShares, { ...formatOptions, maxWidth: col.width }) : "—" };
    case "avg_cost":
      if (totalCostUnits === 0 || !Number.isFinite(totalCost)) return { text: "—" };
      return { text: formatMarketCost(totalCost / Math.abs(totalCostUnits), { ...formatOptions, maxWidth: col.width }) };
    case "cost_basis":
      if (baseMetrics.positionCount === 0 || !Number.isFinite(baseMetrics.totalCost)) return { text: "—" };
      return { text: formatCompact(baseMetrics.totalCost) };
    case "mkt_value":
      return { text: formatCompact(resolvePortfolioMarketValue(baseMetrics, activeQuote ? toBaseQuote(activeQuote.price) : null)?.gross ?? Number.NaN) };
    case "weight": {
      const marketValue = getActiveMarketValue(activeQuote, baseMetrics, toBaseQuote);
      if (marketValue == null || !ctx.portfolioTotalMarketValue) return { text: "—" };
      return { text: formatPercentRaw((marketValue / ctx.portfolioTotalMarketValue) * 100) };
    }
    case "day_pnl":
      if (activeQuote && finiteNumber(activeQuote.change) && Number.isFinite(positionMetrics.grossPriceUnits) && positionMetrics.grossPriceUnits !== 0) {
        const dayPnl = toBaseQuote(totalPriceUnits * activeQuote.change);
        return { text: `${dayPnl >= 0 ? "+" : ""}${formatCompact(dayPnl)}`, color: priceColor(dayPnl) };
      }
      return { text: "—" };
    case "pnl": {
      const pnl = positionPnl.value;
      return pnl === null ? { text: "—", pnlBasis: positionPnl.basis }
        : { text: `${pnl >= 0 ? "+" : ""}${formatCompact(pnl)}`, color: priceColor(pnl), pnlBasis: positionPnl.basis };
    }
    case "pnl_pct": {
      const percent = portfolioPnlPercent(positionPnl.value, baseMetrics.totalCost);
      return percent === null ? { text: "—" } : { text: formatPercentRaw(percent), color: priceColor(percent) };
    }
    case "mark_delta":
      if (!activeQuote || brokerMarkPrice == null || activeQuote.price === 0 || positionMetrics.priceBasis !== (quote?.priceBasis ?? "per-unit") || positionCurrency !== quoteCurrency) return { text: "—" };
      {
        const percent = ((brokerMarkPrice - activeQuote.price) / Math.abs(activeQuote.price)) * 100;
        return { text: formatPercentRaw(percent), color: priceColor(percent) };
      }
    case "acq_date": {
      return { text: formatShortDate(earliestDateAcquired(ticker, ctx.activeTab)) };
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
      return { text: formatShortDate(result.date) };
    }
    case "next_earn": {
      const result = nextEarningsDate(ticker.metadata.ticker, ctx);
      if (result.pending) return { text: "…" };
      return { text: formatShortDate(result.date) };
    }
    case "latency":
      return { text: formatQuoteAgeWithSource(quote, ctx.now, { seconds: true }) };
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
  const activeQuote = getPortfolioQuoteDisplay(positionMetrics, quote);
  const displayQuote = tradedQuoteDisplay(positionMetrics, activeQuote, quote);
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
      return ticker.metadata.name || quote?.name || null;
    case "asset_type":
      return ticker.metadata.assetCategory ?? null;
    case "exchange":
      return quote?.listingExchangeName
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
      if (displayQuote) return displayQuote.price;
      if (brokerMarkPrice != null) return brokerMarkPrice;
      return null;
    case "bid":
      return quote?.bid ?? null;
    case "ask":
      return quote?.ask ?? null;
    case "spread":
      return quote?.bid != null && quote?.ask != null ? quote.ask - quote.bid : null;
    case "spread_pct": {
      if (!finiteNumber(quote?.bid) || !finiteNumber(quote?.ask)) return null;
      const midpoint = (quote.bid + quote.ask) / 2;
      return midpoint !== 0 ? ((quote.ask - quote.bid) / Math.abs(midpoint)) * 100 : null;
    }
    case "bid_ask_size":
      return finiteNumber(quote?.bidSize) || finiteNumber(quote?.askSize)
        ? (quote?.bidSize ?? 0) + (quote?.askSize ?? 0)
        : null;
    case "change":
      return displayQuote?.change ?? null;
    case "change_pct":
      return displayQuote?.changePercent ?? null;
    case "volume":
      return quote?.volume ?? null;
    case "dollar_volume":
      return displayQuote && finiteNumber(quote?.volume)
        ? toBaseQuote(displayQuote.price * quote.volume)
        : null;
    case "range_52w":
      return fiftyTwoWeekPosition(displayQuote, quote);
    case "market_cap": {
      const cap = liveMarketCapitalization(quote, fundamentals);
      return cap ? convertMarketCapitalization(cap.value, cap.currency, ctx.baseCurrency, ctx.exchangeRates) : null;
    }
    case "pe":
      return comparablePriceEarnings(liveTrailingPE(quote, fundamentals));
    case "forward_pe":
      return comparablePriceEarnings(liveForwardPE(quote, fundamentals));
    case "dividend_yield":
      return liveDividendYield(quote, fundamentals) ?? null;
    case "ext_hours":
      if ((quote?.marketState === "PRE" || quote?.marketState === "PREPRE") && quote.preMarketPrice != null) {
        return quote.preMarketChangePercent ?? null;
      }
      if ((quote?.marketState === "POST" || quote?.marketState === "POSTPOST") && quote.postMarketPrice != null) {
        return quote.postMarketChangePercent ?? null;
      }
      return null;
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
    case "weight": {
      const marketValue = getActiveMarketValue(activeQuote, baseMetrics, toBaseQuote);
      return marketValue != null && ctx.portfolioTotalMarketValue
        ? (marketValue / ctx.portfolioTotalMarketValue) * 100
        : null;
    }
    case "day_pnl":
      if (activeQuote && finiteNumber(activeQuote.change) && Number.isFinite(positionMetrics.grossPriceUnits) && positionMetrics.grossPriceUnits !== 0) {
        return toBaseQuote(totalPriceUnits * activeQuote.change);
      }
      return null;
    case "pnl":
      return positionPnl.value;
    case "pnl_pct":
      return portfolioPnlPercent(positionPnl.value, baseMetrics.totalCost);
    case "mark_delta":
      return activeQuote && brokerMarkPrice != null && activeQuote.price !== 0 && positionMetrics.priceBasis === (quote?.priceBasis ?? "per-unit") && positionCurrency === quoteCurrency
        ? ((brokerMarkPrice - activeQuote.price) / Math.abs(activeQuote.price)) * 100
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
    case "latency":
      return quote ? ctx.now - (resolveQuoteAgeTimestamp(quote, ctx.now) ?? ctx.now) : null;
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
