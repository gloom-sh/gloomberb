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
  hasAnalystResearchValue,
  hasCorporateActionsValue,
  mapYahooAnalystResearchResponse,
  mapYahooCalendarEarnings,
  mapYahooDividends,
  mapYahooEarningsCalendarEvent,
  mapYahooEarningsHistory,
  mapYahooSplits,
  yahooRawDate,
} from "./mappers";
import { getYahooSymbolsToTry } from "./symbols";
import type { ChartResult, QuoteSummaryResponse } from "./types";

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
  const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
  let lastError: any;

  for (const symbol of symbolsToTry) {
    try {
      const params = new URLSearchParams({
        modules: "price,majorHoldersBreakdown,institutionOwnership",
      });
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
      const data = await fetchJsonWithCrumb<QuoteSummaryResponse>(url);
      const result = data.quoteSummary?.result?.[0];
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
        name: result.price?.shortName ?? result.price?.longName,
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
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`No holder data for ${ticker}`);
}

export async function loadYahooAnalystResearch({
  exchange = "",
  fetchJsonWithCrumb,
  ticker,
}: YahooQuoteSummaryOptions): Promise<AnalystResearchData> {
  const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
  let firstEmpty: AnalystResearchData | null = null;
  let lastError: any;

  for (const symbol of symbolsToTry) {
    try {
      const params = new URLSearchParams({
        modules: "price,financialData,recommendationTrend,upgradeDowngradeHistory,earningsTrend",
      });
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
      const data = await fetchJsonWithCrumb<QuoteSummaryResponse>(url);
      const result = data.quoteSummary?.result?.[0];
      if (!result) throw new Error(`No analyst data for ${symbol}`);

      const research = mapYahooAnalystResearchResponse(result, symbol);
      if (hasAnalystResearchValue(research)) return research;
      firstEmpty ??= research;
    } catch (err) {
      lastError = err;
    }
  }

  if (firstEmpty) return firstEmpty;
  throw lastError || new Error(`No analyst data for ${ticker}`);
}

export async function loadYahooCorporateActions({
  exchange = "",
  fetchChart,
  fetchJsonWithCrumb,
  providerId,
  ticker,
}: YahooCorporateActionsOptions): Promise<CorporateActionsData> {
  const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
  let firstEmpty: CorporateActionsData | null = null;
  let lastError: any;

  for (const symbol of symbolsToTry) {
    try {
      const params = new URLSearchParams({
        modules: "price,quoteType,calendarEvents,earningsHistory",
      });
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
      const [chartResult, summaryResult] = await Promise.allSettled([
        fetchChart(symbol, "5y", "1d"),
        fetchJsonWithCrumb<QuoteSummaryResponse>(url).then((data) => {
          const result = data.quoteSummary?.result?.[0];
          if (!result) throw new Error(`No corporate actions for ${symbol}`);
          return result;
        }),
      ]);
      if (chartResult.status === "rejected" && summaryResult.status === "rejected") throw summaryResult.reason;
      const chart = chartResult.status === "fulfilled" ? chartResult.value : undefined;
      const result = summaryResult.status === "fulfilled" ? summaryResult.value : undefined;
      const dividendUnit = resolveCurrencyUnit(chart?.meta.currency);

      const actions: CorporateActionsData = {
        providerId,
        fetchedAt: new Date().toISOString(),
        coverage: { dividends: chart ? "available" : "unavailable", splits: chart ? "available" : "unavailable", earnings: result?.calendarEvents || result?.earningsHistory ? "available" : "unavailable" },
        symbol: result?.price?.symbol ?? symbol,
        name: result?.price?.shortName ?? result?.price?.longName,
        currency: dividendUnit.currency || undefined,
        exchange: result?.price?.exchangeName ?? result?.quoteType?.exchange,
        dividends: mapYahooDividends(chart?.events).map((dividend) => ({ ...dividend, amount: dividend.amount / dividendUnit.divisor })),
        splits: mapYahooSplits(chart?.events),
        earnings: [
          ...mapYahooCalendarEarnings(result ?? {}),
          ...mapYahooEarningsHistory(result ?? {}),
        ],
      };

      if (hasCorporateActionsValue(actions)) return actions;
      firstEmpty ??= actions;
    } catch (err) {
      lastError = err;
    }
  }

  if (firstEmpty) return firstEmpty;
  throw lastError || new Error(`No corporate actions for ${ticker}`);
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
        const params = new URLSearchParams({ modules: "calendarEvents,earningsTrend,quoteType" });
        const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
        const data = await fetchJsonWithCrumb<QuoteSummaryResponse>(url);
        const mod = data.quoteSummary?.result?.[0];
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
