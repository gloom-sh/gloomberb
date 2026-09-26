import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  HolderRecord,
} from "../../types/financials";
import type { EarningsEvent } from "../../types/data-provider";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import {
  deriveShareChange,
  financeRawNumber,
  mapYahooAnalystResearchResponse,
  mapYahooCalendarEarnings,
  mapYahooDividends,
  mapYahooEarningsCalendarEvent,
  mapYahooEarningsHistory,
  mapYahooSplits,
  yahooRawDate,
} from "./mappers";
import { getYahooSymbolsToTry, withYahooSymbols } from "./symbols";
import type { ChartResult } from "./types";
import { yahooSecurityName } from "./names";
import { fetchYahooQuoteSummary } from "./requests";
import { hasAnalystResearchValue, hasCorporateActionsValue } from "../provider-router/financials";

interface YahooQuoteSummaryOptions {
  exchange?: string;
  fetchJsonWithCrumb: <T>(url: string) => Promise<T>;
  providerId: string;
  ticker: string;
}

interface YahooCorporateActionsOptions extends YahooQuoteSummaryOptions {
  fetchChart: (symbol: string, range: string, interval?: string) => Promise<{
    meta: NonNullable<ChartResult["meta"]>;
    events?: ChartResult["events"];
  }>;
}

export async function loadYahooHolders({
  exchange = "",
  fetchJsonWithCrumb,
  providerId,
  ticker,
}: YahooQuoteSummaryOptions): Promise<HolderData> {
  return withYahooSymbols(getYahooSymbolsToTry(ticker, exchange), async (symbol) => {
    const result = await fetchYahooQuoteSummary({ fetchJsonWithCrumb }, symbol, "price,majorHoldersBreakdown,institutionOwnership");
    if (!result) throw new Error(`No holder data for ${symbol}`);

    const holders: HolderRecord[] = (result.institutionOwnership?.ownershipList ?? [])
      .map((item): HolderRecord | null => {
        const name = item.organization?.trim();
        if (!name) return null;
        const shares = financeRawNumber(item.position);
        const changePercent = financeRawNumber(item.pctChange);
        return {
          providerId,
          ownerType: "institution",
          name,
          reportDate: yahooRawDate(item.reportDate),
          shares,
          value: financeRawNumber(item.value),
          percentHeld: financeRawNumber(item.pctHeld),
          changePercent,
          changeShares: deriveShareChange(shares, changePercent),
        };
      })
      .filter((holder): holder is HolderRecord => holder !== null);
    const asOf = holders
      .map((holder) => holder.reportDate)
      .filter((date): date is string => !!date)
      .sort()
      .at(-1);

    return {
      providerId,
      symbol: result.price?.symbol ?? symbol,
      name: yahooSecurityName(result.price?.shortName, result.price?.longName),
      currency: result.price?.currency,
      exchange: result.price?.exchangeName,
      asOf,
      summary: {
        insidersPercentHeld: financeRawNumber(result.majorHoldersBreakdown?.insidersPercentHeld),
        institutionsPercentHeld: financeRawNumber(result.majorHoldersBreakdown?.institutionsPercentHeld),
        institutionsFloatPercentHeld: financeRawNumber(result.majorHoldersBreakdown?.institutionsFloatPercentHeld),
        institutionsCount: financeRawNumber(result.majorHoldersBreakdown?.institutionsCount),
      },
      holders,
    };
  });
}

export async function loadYahooAnalystResearch({
  exchange = "",
  fetchJsonWithCrumb,
  ticker,
}: YahooQuoteSummaryOptions): Promise<AnalystResearchData> {
  return withYahooSymbols(getYahooSymbolsToTry(ticker, exchange), async (symbol) => {
    const result = await fetchYahooQuoteSummary(
      { fetchJsonWithCrumb },
      symbol,
      "price,financialData,recommendationTrend,upgradeDowngradeHistory,earningsTrend",
    );
    if (!result) throw new Error(`No analyst data for ${symbol}`);
    return mapYahooAnalystResearchResponse(result, symbol);
  }, hasAnalystResearchValue);
}

export async function loadYahooCorporateActions({
  exchange = "",
  fetchChart,
  fetchJsonWithCrumb,
  providerId,
  ticker,
}: YahooCorporateActionsOptions): Promise<CorporateActionsData> {
  return withYahooSymbols(getYahooSymbolsToTry(ticker, exchange), async (symbol): Promise<CorporateActionsData> => {
    const [chartResult, summaryResult] = await Promise.allSettled([
      fetchChart(symbol, "5y", "1d"),
      fetchYahooQuoteSummary({ fetchJsonWithCrumb }, symbol, "price,quoteType,calendarEvents,earningsHistory,earningsTrend").then((result) => {
        if (!result) throw new Error(`No corporate actions for ${symbol}`);
        return result;
      }),
    ]);
    if (chartResult.status === "rejected" && summaryResult.status === "rejected") throw summaryResult.reason;
    const chart = chartResult.status === "fulfilled" ? chartResult.value : undefined;
    const result = summaryResult.status === "fulfilled" ? summaryResult.value : undefined;
    const dividendUnit = resolveCurrencyUnit(chart?.meta.currency);
    const dividends = mapYahooDividends(chart?.events, chart?.meta);
    const completeDividends = chart && dividends.length === Object.keys(chart.events?.dividends ?? {}).length;

    return {
      providerId,
      fetchedAt: new Date().toISOString(),
      coverage: { dividends: completeDividends ? "available" : "unavailable", splits: chart ? "available" : "unavailable", earnings: result?.calendarEvents || result?.earningsHistory ? "available" : "unavailable" },
      symbol: result?.price?.symbol ?? symbol,
      name: yahooSecurityName(result?.price?.shortName, result?.price?.longName),
      currency: dividendUnit.currency || undefined,
      exchange: result?.price?.exchangeName ?? result?.quoteType?.exchange,
      dividends: dividends.map((dividend) => ({ ...dividend, amount: dividend.amount / dividendUnit.divisor })),
      splits: mapYahooSplits(chart?.events, chart?.meta),
      earnings: [
        ...mapYahooCalendarEarnings(result ?? {}),
        ...mapYahooEarningsHistory(result ?? {}),
      ],
    };
  }, hasCorporateActionsValue);
}

export async function loadYahooEarningsCalendar(
  symbols: string[],
  fetchJsonWithCrumb: <T>(url: string) => Promise<T>,
): Promise<EarningsEvent[]> {
  const results: EarningsEvent[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    const batch = symbols.slice(i, i + BATCH_SIZE);

    const settled = await Promise.allSettled(
      batch.map(async (symbol) => {
        const mod = await fetchYahooQuoteSummary({ fetchJsonWithCrumb }, symbol, "calendarEvents,earningsTrend,earningsHistory,quoteType");
        return mod ? mapYahooEarningsCalendarEvent(mod, symbol) : null;
      }),
    );

    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }
  }

  results.sort((a, b) => a.earningsDate.getTime() - b.earningsDate.getTime());
  return results;
}
