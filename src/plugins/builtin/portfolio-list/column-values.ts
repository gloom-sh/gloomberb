import type { ColumnConfig } from "../../../types/config";
import type { AnalystResearchData, CorporateActionsData, MarketState, TickerFinancials } from "../../../types/financials";
import type { EarningsEvent } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { priceColor } from "../../../theme/colors";
import { formatQuoteAgeWithSource, resolveQuoteAgeTimestamp } from "../../../market-data/quotes/time";
import { convertCurrency, formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";
import {
  formatMarketCost,
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
import {
  getPortfolioPositionMetrics,
  resolveBrokerFallbackMarketValue,
  resolveBrokerFallbackPnl,
  signedQuoteUnrealizedPnl,
} from "./position-metrics";

export interface ColumnContext {
  activeTab?: string;
  baseCurrency: string;
  exchangeRates: Map<string, number>;
  now: number;
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
  return Math.max(0, Math.floor((startOfUtcDay(new Date(now)) - startOfUtcDay(date)) / 86_400_000));
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
  const shortCount = positions.filter((position) => position.side === "short").length;
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

function getActiveMarketValue(
  activeQuote: ActiveQuoteDisplay | null,
  positionMetrics: ReturnType<typeof getPortfolioPositionMetrics>,
  toBaseQuote: (value: number) => number,
  toBasePosition: (value: number) => number,
): number | null {
  if (activeQuote && positionMetrics.totalPriceUnits !== 0) {
    return toBaseQuote(Math.abs(positionMetrics.totalPriceUnits) * activeQuote.price);
  }
  const brokerFallbackMktValue = resolveBrokerFallbackMarketValue(positionMetrics);
  return brokerFallbackMktValue == null ? null : toBasePosition(brokerFallbackMktValue);
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
): { text: string; color?: string } {
  const quote = financials?.quote;
  const activeQuote = getActiveQuoteDisplay(quote);
  const fundamentals = financials?.fundamentals;
  const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

  const positionMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency);
  const { positionCurrency, totalShares, totalCost, totalCostUnits, totalPriceUnits, multiplierHint, brokerMarkPrice } = positionMetrics;
  const brokerFallbackMktValue = resolveBrokerFallbackMarketValue(positionMetrics);
  const brokerFallbackPnl = resolveBrokerFallbackPnl(positionMetrics, brokerFallbackMktValue);
  const toBaseQuote = (value: number) =>
    convertCurrency(value, quoteCurrency, ctx.baseCurrency, ctx.exchangeRates);
  const toBasePosition = (value: number) =>
    convertCurrency(value, positionCurrency, ctx.baseCurrency, ctx.exchangeRates);
  const formatOptions: MarketFormatOptions = {
    assetCategory: ticker.metadata.assetCategory,
    multiplier: multiplierHint,
  };

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
      return resolvePortfolioPriceValue(activeQuote, brokerMarkPrice, formatOptions, col.width, quote?.marketState);
    case "change":
      if (!activeQuote) return { text: "—" };
      return {
        text: formatSignedMarketPrice(activeQuote.change, { ...formatOptions, maxWidth: col.width }),
        color: marketChangeColor(activeQuote.change, quote?.marketState),
      };
    case "bid":
      return { text: quote?.bid != null ? formatMarketPrice(quote.bid, { ...formatOptions, maxWidth: col.width }) : "—" };
    case "ask":
      return { text: quote?.ask != null ? formatMarketPrice(quote.ask, { ...formatOptions, maxWidth: col.width }) : "—" };
    case "spread":
      return {
        text: quote?.bid != null && quote?.ask != null
          ? formatMarketPrice(quote.ask - quote.bid, { ...formatOptions, maxWidth: col.width })
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
      return activeQuote
        ? { text: formatPercentRaw(activeQuote.changePercent), color: marketChangeColor(activeQuote.changePercent, quote?.marketState) }
        : { text: quote ? formatPercentRaw(quote.changePercent) : "—", color: quote ? marketChangeColor(quote.changePercent, quote.marketState) : undefined };
    case "volume":
      return { text: finiteNumber(quote?.volume) ? formatCompact(quote.volume) : "—" };
    case "dollar_volume": {
      if (!activeQuote || !finiteNumber(quote?.volume)) return { text: "—" };
      return { text: formatCompact(toBaseQuote(activeQuote.price * quote.volume)) };
    }
    case "range_52w": {
      if (!activeQuote || !finiteNumber(quote?.high52w) || !finiteNumber(quote?.low52w)) return { text: "—" };
      const range = quote.high52w - quote.low52w;
      if (range <= 0) return { text: "—" };
      const position = ((activeQuote.price - quote.low52w) / range) * 100;
      return { text: formatPercentRaw(Math.max(0, Math.min(100, position))) };
    }
    case "market_cap":
      if (!quote?.marketCap) return { text: "—" };
      return { text: formatCompact(toBaseQuote(quote.marketCap)) };
    case "pe":
      return { text: fundamentals?.trailingPE ? formatNumber(fundamentals.trailingPE, 1) : "—" };
    case "forward_pe":
      return { text: fundamentals?.forwardPE ? formatNumber(fundamentals.forwardPE, 1) : "—" };
    case "dividend_yield":
      return {
        text: fundamentals?.dividendYield != null ? `${(fundamentals.dividendYield * 100).toFixed(2)}%` : "—",
      };
    case "ext_hours":
      if ((quote?.marketState === "PRE" || quote?.marketState === "PREPRE") && quote.preMarketPrice != null) {
        const changePercent = activeQuote?.changePercent ?? quote.preMarketChangePercent ?? 0;
        return { text: formatPercentRaw(changePercent), color: priceColor(changePercent) };
      }
      if ((quote?.marketState === "POST" || quote?.marketState === "POSTPOST") && quote.postMarketPrice != null) {
        const changePercent = activeQuote?.changePercent ?? quote.postMarketChangePercent ?? 0;
        return { text: formatPercentRaw(changePercent), color: priceColor(changePercent) };
      }
      return { text: "—" };
    case "side":
      return { text: positionSideLabel(ticker, ctx.activeTab) ?? "—" };
    case "shares":
      return { text: totalShares !== 0 ? formatMarketQuantity(totalShares, { ...formatOptions, maxWidth: col.width }) : "—" };
    case "avg_cost":
      if (totalCostUnits === 0) return { text: "—" };
      return { text: formatMarketCost(totalCost / Math.abs(totalCostUnits), { ...formatOptions, maxWidth: col.width }) };
    case "cost_basis":
      if (totalCost === 0) return { text: "—" };
      return { text: formatCompact(toBasePosition(totalCost)) };
    case "mkt_value":
      if (activeQuote && totalPriceUnits !== 0) {
        return { text: formatCompact(toBaseQuote(Math.abs(totalPriceUnits) * activeQuote.price)) };
      }
      if (brokerFallbackMktValue != null) {
        return { text: formatCompact(toBasePosition(brokerFallbackMktValue)) };
      }
      return { text: "—" };
    case "weight": {
      const marketValue = getActiveMarketValue(activeQuote, positionMetrics, toBaseQuote, toBasePosition);
      if (marketValue == null || !ctx.portfolioTotalMarketValue) return { text: "—" };
      return { text: formatPercentRaw((marketValue / ctx.portfolioTotalMarketValue) * 100) };
    }
    case "day_pnl":
      if (activeQuote && totalPriceUnits !== 0) {
        const dayPnl = toBaseQuote(totalPriceUnits * activeQuote.change);
        return { text: `${dayPnl >= 0 ? "+" : ""}${formatCompact(dayPnl)}`, color: priceColor(dayPnl) };
      }
      return { text: "—" };
    case "pnl":
      if (activeQuote && totalPriceUnits !== 0) {
        const pnl = signedQuoteUnrealizedPnl(
          toBaseQuote(Math.abs(totalPriceUnits) * activeQuote.price),
          toBasePosition(totalCost),
          totalPriceUnits,
        );
        return { text: `${pnl >= 0 ? "+" : ""}${formatCompact(pnl)}`, color: priceColor(pnl) };
      }
      if (brokerFallbackPnl != null) {
        const pnl = toBasePosition(brokerFallbackPnl);
        return { text: `${pnl >= 0 ? "+" : ""}${formatCompact(pnl)}`, color: priceColor(pnl) };
      }
      return { text: "—" };
    case "pnl_pct":
      if (activeQuote && totalCost !== 0) {
        const marketValue = toBaseQuote(Math.abs(totalPriceUnits) * activeQuote.price);
        const costBasis = toBasePosition(totalCost);
        const pnl = signedQuoteUnrealizedPnl(marketValue, costBasis, totalPriceUnits);
        const percent = costBasis !== 0 ? (pnl / costBasis) * 100 : 0;
        return { text: formatPercentRaw(percent), color: priceColor(percent) };
      }
      if (brokerFallbackPnl != null && totalCost !== 0) {
        const costBasis = toBasePosition(totalCost);
        const pnl = toBasePosition(brokerFallbackPnl);
        const percent = costBasis !== 0 ? (pnl / costBasis) * 100 : 0;
        return { text: formatPercentRaw(percent), color: priceColor(percent) };
      }
      return { text: "—" };
    case "mark_delta":
      if (!activeQuote || brokerMarkPrice == null || activeQuote.price === 0) return { text: "—" };
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
      const current = analyst.data?.priceTarget?.current ?? activeQuote?.price;
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
      return { text: formatQuoteAgeWithSource(quote, ctx.now) };
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
  const activeQuote = getActiveQuoteDisplay(quote);
  const fundamentals = financials?.fundamentals;
  const quoteCurrency = quote?.currency || ticker.metadata.currency || "USD";

  const positionMetrics = getPortfolioPositionMetrics(ticker, ctx.activeTab, quoteCurrency);
  const { positionCurrency, totalShares, totalCost, totalCostUnits, totalPriceUnits, brokerMarkPrice } = positionMetrics;
  const brokerFallbackMktValue = resolveBrokerFallbackMarketValue(positionMetrics);
  const brokerFallbackPnl = resolveBrokerFallbackPnl(positionMetrics, brokerFallbackMktValue);
  const toBaseQuote = (value: number) =>
    convertCurrency(value, quoteCurrency, ctx.baseCurrency, ctx.exchangeRates);
  const toBasePosition = (value: number) =>
    convertCurrency(value, positionCurrency, ctx.baseCurrency, ctx.exchangeRates);

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
      if (activeQuote) return activeQuote.price;
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
      return activeQuote ? activeQuote.change : null;
    case "change_pct":
      return activeQuote?.changePercent ?? null;
    case "volume":
      return quote?.volume ?? null;
    case "dollar_volume":
      return activeQuote && finiteNumber(quote?.volume)
        ? toBaseQuote(activeQuote.price * quote.volume)
        : null;
    case "range_52w": {
      if (!activeQuote || !finiteNumber(quote?.high52w) || !finiteNumber(quote?.low52w)) return null;
      const range = quote.high52w - quote.low52w;
      return range > 0 ? ((activeQuote.price - quote.low52w) / range) * 100 : null;
    }
    case "market_cap":
      return quote?.marketCap ? toBaseQuote(quote.marketCap) : null;
    case "pe":
      return fundamentals?.trailingPE ?? null;
    case "forward_pe":
      return fundamentals?.forwardPE ?? null;
    case "dividend_yield":
      return fundamentals?.dividendYield ?? null;
    case "ext_hours":
      if ((quote?.marketState === "PRE" || quote?.marketState === "PREPRE") && quote.preMarketPrice != null) {
        return activeQuote?.changePercent ?? quote.preMarketChangePercent ?? 0;
      }
      if ((quote?.marketState === "POST" || quote?.marketState === "POSTPOST") && quote.postMarketPrice != null) {
        return activeQuote?.changePercent ?? quote.postMarketChangePercent ?? 0;
      }
      return null;
    case "side":
      return positionSideLabel(ticker, ctx.activeTab);
    case "shares":
      return totalShares !== 0 ? totalShares : null;
    case "avg_cost":
      return totalCostUnits !== 0 ? totalCost / Math.abs(totalCostUnits) : null;
    case "cost_basis":
      return totalCost !== 0 ? toBasePosition(totalCost) : null;
    case "mkt_value":
      if (activeQuote && totalPriceUnits !== 0) {
        return toBaseQuote(Math.abs(totalPriceUnits) * activeQuote.price);
      }
      if (brokerFallbackMktValue != null) {
        return toBasePosition(brokerFallbackMktValue);
      }
      return null;
    case "weight": {
      const marketValue = getActiveMarketValue(activeQuote, positionMetrics, toBaseQuote, toBasePosition);
      return marketValue != null && ctx.portfolioTotalMarketValue
        ? (marketValue / ctx.portfolioTotalMarketValue) * 100
        : null;
    }
    case "day_pnl":
      if (activeQuote && totalPriceUnits !== 0) {
        return toBaseQuote(totalPriceUnits * activeQuote.change);
      }
      return null;
    case "pnl":
      if (activeQuote && totalPriceUnits !== 0) {
        return signedQuoteUnrealizedPnl(
          toBaseQuote(Math.abs(totalPriceUnits) * activeQuote.price),
          toBasePosition(totalCost),
          totalPriceUnits,
        );
      }
      if (brokerFallbackPnl != null) {
        return toBasePosition(brokerFallbackPnl);
      }
      return null;
    case "pnl_pct":
      if (activeQuote && totalCost !== 0) {
        const marketValue = toBaseQuote(Math.abs(totalPriceUnits) * activeQuote.price);
        const costBasis = toBasePosition(totalCost);
        const pnl = signedQuoteUnrealizedPnl(marketValue, costBasis, totalPriceUnits);
        return costBasis !== 0 ? (pnl / costBasis) * 100 : null;
      }
      if (brokerFallbackPnl != null && totalCost !== 0) {
        const costBasis = toBasePosition(totalCost);
        const pnl = toBasePosition(brokerFallbackPnl);
        return costBasis !== 0 ? (pnl / costBasis) * 100 : null;
      }
      return null;
    case "mark_delta":
      return activeQuote && brokerMarkPrice != null && activeQuote.price !== 0
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
      const current = analyst.data?.priceTarget?.current ?? activeQuote?.price;
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
      const values = (financials?.priceHistory ?? [])
        .map((point) => point.close)
        .filter((value) => Number.isFinite(value));
      const first = values[0];
      const last = values.at(-1);
      return first != null && last != null && first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
    }
    default:
      return null;
  }
}
