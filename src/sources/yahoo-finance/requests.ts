import type {
  CompanyProfile,
  PricePoint,
  Quote,
} from "../../types/financials";
import {
  deriveMarketState,
  extractExtendedHoursPrices,
  financeRawNumber,
  normalizeMarketValue,
  normalizePositiveMarketValue,
  type ExtendedHoursData,
} from "./mappers";
import type {
  ChartResponse,
  ChartResult,
  QuoteSummaryResponse,
  TimeseriesResponse,
} from "./types";
import type { YahooHttpClient } from "./http";
import { applyYahooHistoryCoverage } from "../history-coverage";

export async function fetchYahooChart(
  http: YahooHttpClient,
  symbol: string,
  range: string,
  interval = "1d",
  includePrePost = false,
): Promise<{
  meta: NonNullable<ChartResult["meta"]>;
  history: PricePoint[];
  events: ChartResult["events"];
}> {
  const params = new URLSearchParams({
    interval,
    range,
    includePrePost: String(includePrePost),
    events: "div,split",
  });
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const data = await http.fetchJson<ChartResponse>(url);
  const result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) {
    throw new Error(data.chart?.error?.description || `No chart data for ${symbol}`);
  }
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error(`Missing indicators for ${symbol}`);

  const history: PricePoint[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = quote.close?.[i];
    if (close == null || !Number.isFinite(close) || close <= 0) continue;
    history.push({
      date: new Date((result.timestamp[i]!) * 1000),
      open: quote.open?.[i] ?? undefined,
      high: quote.high?.[i] ?? undefined,
      low: quote.low?.[i] ?? undefined,
      close,
      volume: quote.volume?.[i] ?? undefined,
    });
  }
  return { meta: result.meta || {},
    history: applyYahooHistoryCoverage(symbol, result.meta || {}, interval, history),
    events: result.events };
}

export async function fetchYahooExtendedHoursData(
  http: YahooHttpClient,
  symbol: string,
  meta: NonNullable<ChartResult["meta"]>,
  regularClose?: number,
): Promise<ExtendedHoursData> {
  const marketState = deriveMarketState(meta);
  if (marketState !== "PRE" && marketState !== "POST") return {};

  try {
    const params = new URLSearchParams({
      interval: "5m",
      range: "1d",
      includePrePost: "true",
    });
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
    const data = await http.fetchJson<ChartResponse>(url);
    const result = data.chart?.result?.[0];
    if (!result?.timestamp?.length) return {};
    const closes = result.indicators?.quote?.[0]?.close || [];
    return extractExtendedHoursPrices(meta, result.timestamp, closes, marketState, regularClose);
  } catch {
    return {};
  }
}

export async function fetchYahooTimeseries(
  http: YahooHttpClient,
  symbol: string,
  types: string[],
  period1 = "2010-01-01",
): Promise<Array<Record<string, any>>> {
  const p1 = Math.floor(new Date(period1).getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    type: types.join(","),
    period1: String(p1),
    period2: String(p2),
  });
  const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?${params}`;
  const data = await http.fetchJson<TimeseriesResponse>(url);
  return data.timeseries?.result || [];
}

export async function fetchYahooAssetProfile(
  http: YahooHttpClient,
  symbol: string,
): Promise<CompanyProfile | undefined> {
  const params = new URLSearchParams({ modules: "assetProfile" });
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
  const data = await http.fetchJsonWithCrumb<QuoteSummaryResponse>(url);
  const profile = data.quoteSummary?.result?.[0]?.assetProfile;
  if (!profile) return undefined;

  const normalized: CompanyProfile = {
    description: profile.longBusinessSummary?.trim() || undefined,
    sector: profile.sector?.trim() || undefined,
    industry: profile.industry?.trim() || undefined,
  };

  return normalized.description || normalized.sector || normalized.industry
    ? normalized
    : undefined;
}

export async function fetchYahooQuoteSupplement(
  http: YahooHttpClient,
  symbol: string,
  currencyDivisor = 1,
): Promise<
  Pick<
    Quote,
    | "bid"
    | "ask"
    | "bidSize"
    | "askSize"
    | "previousClose"
    | "open"
    | "high"
    | "low"
  >
> {
  try {
    const params = new URLSearchParams({ modules: "summaryDetail" });
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
    const data = await http.fetchJsonWithCrumb<QuoteSummaryResponse>(url);
    const summaryDetail = data.quoteSummary?.result?.[0]?.summaryDetail;
    if (!summaryDetail) return {};

    const bid = normalizePositiveMarketValue(
      financeRawNumber(summaryDetail.bid),
      currencyDivisor,
    );
    const ask = normalizePositiveMarketValue(
      financeRawNumber(summaryDetail.ask),
      currencyDivisor,
    );
    const bidSize = financeRawNumber(summaryDetail.bidSize);
    const askSize = financeRawNumber(summaryDetail.askSize);
    const previousClose = normalizeMarketValue(
      financeRawNumber(summaryDetail.previousClose),
      currencyDivisor,
    );
    const open = normalizeMarketValue(
      financeRawNumber(summaryDetail.open),
      currencyDivisor,
    );
    const high = normalizeMarketValue(
      financeRawNumber(summaryDetail.dayHigh),
      currencyDivisor,
    );
    const low = normalizeMarketValue(
      financeRawNumber(summaryDetail.dayLow),
      currencyDivisor,
    );

    return {
      bid,
      ask,
      bidSize,
      askSize,
      previousClose,
      open,
      high,
      low,
    };
  } catch {
    return {};
  }
}
