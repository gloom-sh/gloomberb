import type { AppConfig } from "../types/config";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { TickerPosition, TickerRecord } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import { convertCurrency } from "../utils/format";
import { fxRateCurrencies } from "../utils/currency-units";
import { getSharedMarketDataCoordinator, resolveEntryValue } from "../market-data/coordinator";
import {
  computeDatedBeta,
  resolveDatedReturns,
  computeWeightedPortfolioReturns,
  syntheticAccountUnsupportedReason,
  syntheticPositionUnsupportedReason,
  type DatedReturn,
  type ReturnHistoryResult,
  type WeightedReturnSeries,
} from "../portfolio/return-metrics";
import {
  getSyncedProfileAnalytics,
  setSyncedProfileAnalytics,
} from "./profile-analytics";
import { isRecord } from "../utils/guards";
import { positionContractMultiplier } from "../portfolio/position-metrics";
import { logFailure } from "../utils/log-failure";
import { historyMemo, pricePointTimeOrNull } from "./history-memo";

function positionValueBase(
  ticker: TickerRecord,
  position: TickerPosition,
  financials: TickerFinancials | null | undefined,
  baseCurrency: string,
  exchangeRates: Map<string, number>,
): number | null {
  const quoteCurrency = financials?.quote?.currency || position.currency || baseCurrency;
  const positionCurrency = position.currency || quoteCurrency;
  if (typeof position.marketValue === "number" && Number.isFinite(position.marketValue)) {
    return convertCurrency(Math.abs(position.marketValue), positionCurrency, baseCurrency, exchangeRates);
  }
  const hasMarkPrice = typeof position.markPrice === "number" && Number.isFinite(position.markPrice);
  const hasQuotePrice = typeof financials?.quote?.price === "number" && Number.isFinite(financials.quote.price);
  const price = hasMarkPrice ? position.markPrice : hasQuotePrice ? financials!.quote!.price : position.avgCost;
  // The multiplier the portfolio values the lot by: a future of unknown size has no value, never one at 1x.
  const multiplier = positionContractMultiplier(ticker, position);
  if (!Number.isFinite(position.shares) || typeof price !== "number" || !Number.isFinite(price) || multiplier === null) return null;
  return convertCurrency(
    Math.abs(position.shares * price * multiplier),
    hasQuotePrice && !hasMarkPrice ? quoteCurrency : positionCurrency,
    baseCurrency,
    exchangeRates,
  );
}

function recentPriceHistory(history: PricePoint[], days: number): PricePoint[] {
  let latestTime = 0;
  for (const point of history) {
    const time = pricePointTimeOrNull(point);
    if (time != null && time > latestTime) latestTime = time;
  }
  if (latestTime <= 0) return [];
  const cutoff = latestTime - days * 24 * 60 * 60 * 1000;
  return history.filter((point) => {
    const time = pricePointTimeOrNull(point);
    return time != null && time >= cutoff;
  });
}

/** A holding's daily returns over its last year of bars. */
const lastYearReturns = historyMemo((history): ReturnHistoryResult => resolveDatedReturns(recentPriceHistory(history, 366)));

/** The holdings' beta to SPY at today's weights, worked out only when no preview supplies one. */
function holdingsBeta(series: WeightedReturnSeries[], spyReturns: DatedReturn[]): number | null {
  if (series.length === 0 || spyReturns.length === 0) return null;
  const returns = computeWeightedPortfolioReturns(series);
  return returns.length > 0 ? computeDatedBeta(returns, spyReturns) : null;
}

export function collectAnalyticsByPortfolio(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
  exchangeRates: Map<string, number>,
  brokerAccounts: Record<string, BrokerAccount[]>,
) {
  const output: Record<string, Record<string, unknown>> = {};
  const spySample = lastYearReturns(financials.get("SPY")?.priceHistory);
  const spyReturns = spySample.returns;
  for (const portfolio of config.portfolios) {
    const account = portfolio.brokerInstanceId && portfolio.brokerAccountId
      ? brokerAccounts[portfolio.brokerInstanceId]?.find((entry) => entry.accountId === portfolio.brokerAccountId)
      : undefined;
    let unsupported = !!syntheticAccountUnsupportedReason(account);
    let invalidHistory = false;
    const datedReturnSeries: WeightedReturnSeries[] = [];
    for (const ticker of tickers.values()) {
      const tickerFinancials = financials.get(ticker.metadata.ticker);
      const portfolioPositions = ticker.metadata.positions.filter((position) => position.portfolio === portfolio.id);
      if (portfolioPositions.length === 0) continue;
      unsupported ||= !!syntheticPositionUnsupportedReason(
        ticker, tickerFinancials?.quote?.currency || ticker.metadata.currency || config.baseCurrency, portfolio.id,
      );
      for (const position of portfolioPositions) {
        if (position.shares === 0) continue;
        const value = positionValueBase(ticker, position, tickerFinancials, config.baseCurrency, exchangeRates);
        if (value == null || !Number.isFinite(value)) {
          unsupported = true;
          continue;
        }
        const sample = lastYearReturns(tickerFinancials?.priceHistory);
        invalidHistory ||= sample.integrity != null;
        const returns = sample.returns;
        if (returns.length >= 10) datedReturnSeries.push({ weight: value, returns });
        else unsupported = true;
      }
    }
    const previewAnalytics = getSyncedProfileAnalytics(portfolio.id);
    // The broker's own returns do not depend on the holdings' price histories.
    const accountBasis = previewAnalytics?.basis === "account";
    // A weighted history of today's holdings is not the investor's actual
    // one-year account return. Only preserve an explicitly supplied preview.
    const oneYearReturn = invalidHistory && !accountBasis ? null : previewAnalytics?.oneYearReturn ?? null;
    const spyBeta = (invalidHistory && !accountBasis) || spySample.integrity ? null : previewAnalytics?.spyBeta
      ?? holdingsBeta(unsupported ? [] : datedReturnSeries, spyReturns);
    output[portfolio.id] = {
      oneYearReturn,
      spyBeta,
      basis: oneYearReturn == null && spyBeta == null ? null : previewAnalytics?.basis ?? "holdings",
    };
  }
  return output;
}

export function collectAccountsByPortfolio(
  config: AppConfig,
  brokerAccounts: Record<string, BrokerAccount[]>,
) {
  const output: Record<string, Record<string, string | number>> = {};
  for (const portfolio of config.portfolios) {
    if (!portfolio.brokerInstanceId || !portfolio.brokerAccountId) continue;
    const account = brokerAccounts[portfolio.brokerInstanceId]?.find(
      (entry) => entry.accountId === portfolio.brokerAccountId,
    );
    if (!account || !Number.isFinite(account.netLiquidation)) continue;
    output[portfolio.id] = {
      currency: account.currency ?? portfolio.currency ?? config.baseCurrency,
      netLiquidation: account.netLiquidation!,
      ...(Number.isFinite(account.dailyPnl) ? { dailyPnl: account.dailyPnl! } : {}),
      ...(Number.isFinite(account.unrealizedPnl) ? { unrealizedPnl: account.unrealizedPnl! } : {}),
      ...(Number.isFinite(account.updatedAt) ? { updatedAt: account.updatedAt! } : {}),
    };
  }
  return output;
}

/**
 * USD-per-unit rates for the base currency and every currency a holding is
 * valued in, read from the same FX store the portfolio panes use. A currency
 * without a usable rate stays missing, so its holdings count as unsupported.
 */
export async function loadHoldingExchangeRates(
  config: AppConfig,
  tickers: Map<string, TickerRecord>,
  financials: Map<string, TickerFinancials>,
): Promise<Map<string, number>> {
  const rates = new Map([["USD", 1]]);
  const coordinator = getSharedMarketDataCoordinator();
  if (!coordinator) return rates;
  const held: Array<string | undefined> = [config.baseCurrency];
  for (const ticker of tickers.values()) {
    if (ticker.metadata.positions.length === 0) continue;
    held.push(financials.get(ticker.metadata.ticker)?.quote?.currency);
    for (const position of ticker.metadata.positions) held.push(position.currency);
  }
  // With a minor unit's major currency, as the panes load them (GBX and ILA have no rate of their own).
  const currencies = fxRateCurrencies(held).filter((currency) => currency !== "USD");
  await Promise.all(currencies.map(async (currency) => {
    // A failed FX load must not hold back the rest of the push.
    await coordinator.loadFxRate(currency).catch(logFailure("sync.core-contributors", "Load holding FX rate for sync failed"));
    const rate = resolveEntryValue(coordinator.getFxEntry(currency));
    if (rate != null) rates.set(currency, rate);
  }));
  return rates;
}

export function hydrateProfileAnalytics(payload: Record<string, unknown>): void {
  if (!isRecord(payload.analyticsByPortfolio)) return;
  for (const [portfolioId, analytics] of Object.entries(payload.analyticsByPortfolio)) {
    if (!isRecord(analytics)) continue;
    setSyncedProfileAnalytics(portfolioId, {
      oneYearReturn: typeof analytics.oneYearReturn === "number" ? analytics.oneYearReturn : null,
      spyBeta: typeof analytics.spyBeta === "number" ? analytics.spyBeta : null,
      basis: analytics.basis === "account" || analytics.basis === "holdings" ? analytics.basis : null,
    });
  }
}
