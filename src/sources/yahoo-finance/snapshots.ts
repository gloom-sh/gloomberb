import type {
  CompanyProfile,
  Fundamentals,
  PricePoint,
  Quote,
  TickerFinancials,
} from "../../types/financials";
import {
  buildYahooStatements,
  computeYahooReturn,
  latestYahooMetric,
  parseYahooTimeseries,
  YAHOO_TIMESERIES_TYPES,
} from "./financials";
import {
  deriveMarketState,
  normalizeSubUnitCurrency,
  type ExtendedHoursData,
} from "./mappers";
import type { ChartResult } from "./types";

type YahooChartSnapshot = {
  meta: NonNullable<ChartResult["meta"]>;
  history: PricePoint[];
};

type YahooQuoteSupplement = Pick<
  Quote,
  | "bid"
  | "ask"
  | "bidSize"
  | "askSize"
  | "previousClose"
  | "open"
  | "high"
  | "low"
>;

interface YahooSnapshotLoaders {
  fetchAssetProfile: (symbol: string) => Promise<CompanyProfile | undefined>;
  fetchChart: (symbol: string, range: string, interval?: string) => Promise<YahooChartSnapshot>;
  fetchExtendedHoursData: (
    symbol: string,
    meta: NonNullable<ChartResult["meta"]>,
    regularClose?: number,
  ) => Promise<ExtendedHoursData>;
  fetchQuoteSupplement: (
    symbol: string,
    currencyDivisor?: number,
  ) => Promise<YahooQuoteSupplement>;
  fetchTimeseries: (
    symbol: string,
    types: string[],
    period1?: string,
  ) => Promise<Array<Record<string, any>>>;
  providerId: string;
}

type YahooQuoteLoaders = Pick<
  YahooSnapshotLoaders,
  "fetchChart" | "fetchExtendedHoursData" | "fetchQuoteSupplement" | "providerId"
>;

function normalizePriceHistory(history: PricePoint[], currencyDivisor: number): void {
  for (const point of history) {
    point.close /= currencyDivisor;
    if (point.open != null) point.open /= currencyDivisor;
    if (point.high != null) point.high /= currencyDivisor;
    if (point.low != null) point.low /= currencyDivisor;
  }
}

function normalizeChartMetaPrices(
  meta: NonNullable<ChartResult["meta"]>,
  currencyDivisor: number,
): void {
  if (meta.regularMarketPrice != null) meta.regularMarketPrice /= currencyDivisor;
  if (meta.chartPreviousClose != null) meta.chartPreviousClose /= currencyDivisor;
  if (meta.fiftyTwoWeekHigh != null) meta.fiftyTwoWeekHigh /= currencyDivisor;
  if (meta.fiftyTwoWeekLow != null) meta.fiftyTwoWeekLow /= currencyDivisor;
}

function normalizeExtendedHoursPrices(
  extHours: ExtendedHoursData,
  currencyDivisor: number,
): void {
  if (extHours.preMarketPrice != null) extHours.preMarketPrice /= currencyDivisor;
  if (extHours.preMarketChange != null) extHours.preMarketChange /= currencyDivisor;
  if (extHours.postMarketPrice != null) extHours.postMarketPrice /= currencyDivisor;
  if (extHours.postMarketChange != null) extHours.postMarketChange /= currencyDivisor;
}

function normalizeChartCurrency(
  chart: YahooChartSnapshot,
): { normalizedCurrency: string; currencyDivisor: number } {
  const rawCurrency = chart.meta.currency || "USD";
  const { currency: normalizedCurrency, divisor: currencyDivisor } =
    normalizeSubUnitCurrency(rawCurrency);

  if (currencyDivisor !== 1) {
    normalizePriceHistory(chart.history, currencyDivisor);
    normalizeChartMetaPrices(chart.meta, currencyDivisor);
  }

  return { normalizedCurrency, currencyDivisor };
}

export async function loadYahooTickerFinancials(
  symbol: string,
  loaders: YahooSnapshotLoaders,
): Promise<TickerFinancials> {
  const [chart, tsRaw, profile] = await Promise.all([
    loaders.fetchChart(symbol, "5y"),
    loaders.fetchTimeseries(symbol, [
      ...YAHOO_TIMESERIES_TYPES.annual,
      ...YAHOO_TIMESERIES_TYPES.quarterly,
      ...YAHOO_TIMESERIES_TYPES.trailing,
    ]),
    loaders.fetchAssetProfile(symbol).catch(() => undefined),
  ]);

  const { meta, history } = chart;
  if (!history.length) throw new Error(`No history for ${symbol}`);

  const metrics = parseYahooTimeseries(tsRaw);
  const latest = (type: string) => latestYahooMetric(metrics, type);
  const { normalizedCurrency, currencyDivisor } = normalizeChartCurrency(chart);
  const quoteSupplement = await loaders.fetchQuoteSupplement(symbol, currencyDivisor);

  const currentPrice = meta.regularMarketPrice ?? history[history.length - 1]!.close;
  const prev = history.length > 1 ? history[history.length - 2]!.close : meta.chartPreviousClose;
  const change = prev != null ? currentPrice - prev : 0;
  const changePct = prev ? (change / prev) * 100 : 0;

  const marketState = deriveMarketState(meta);
  const extendedHoursBase = quoteSupplement.previousClose ?? prev;
  const extHours = await loaders.fetchExtendedHoursData(
    symbol,
    meta,
    extendedHoursBase == null ? undefined : extendedHoursBase * currencyDivisor,
  );
  if (currencyDivisor !== 1) {
    normalizeExtendedHoursPrices(extHours, currencyDivisor);
  }

  const quote: Quote = {
    symbol,
    providerId: loaders.providerId,
    price: currentPrice,
    currency: normalizedCurrency,
    change,
    changePercent: changePct,
    high52w: meta.fiftyTwoWeekHigh,
    low52w: meta.fiftyTwoWeekLow,
    marketCap: latest("trailingMarketCap"),
    name: meta.shortName || meta.longName,
    lastUpdated: yahooMarketTimestamp(meta),
    exchangeName: meta.exchangeName,
    fullExchangeName: meta.fullExchangeName,
    listingExchangeName: meta.exchangeName,
    listingExchangeFullName: meta.fullExchangeName,
    marketState,
    sessionConfidence: "derived",
    dataSource: "delayed",
    ...quoteSupplement,
    ...extHours,
  };

  const revenue = latest("annualTotalRevenue");
  const netIncome = latest("annualNetIncome");

  const annualStatements = buildYahooStatements(metrics, "annual");
  const quarterlyStatements = buildYahooStatements(metrics, "quarterly");
  const financialCurrency = annualStatements.at(-1)?.currency ?? quarterlyStatements.at(-1)?.currency;
  const fundamentals: Fundamentals = {
    financialCurrency,
    trailingPE: latest("trailingPeRatio"),
    forwardPE: latest("trailingForwardPeRatio"),
    pegRatio: latest("trailingPegRatio"),
    enterpriseValue: latest("trailingEnterpriseValue"),
    operatingCashFlow: latest("trailingOperatingCashFlow"),
    freeCashFlow: latest("trailingFreeCashFlow"),
    dividendYield: latest("trailingDividendYield"),
    revenue,
    netIncome,
    eps: latest("annualDilutedEPS"),
    operatingMargin: revenue && latest("annualOperatingIncome") != null
      ? latest("annualOperatingIncome")! / revenue
      : undefined,
    profitMargin: revenue && netIncome != null ? netIncome / revenue : undefined,
    return1Y: computeYahooReturn(history, 365),
    return3Y: computeYahooReturn(history, 3 * 365),
    sharesOutstanding: latest("annualDilutedAverageShares"),
  };

  return {
    quote,
    fundamentals,
    profile,
    financialCurrency,
    annualStatements,
    quarterlyStatements,
    priceHistory: history,
  };
}

export async function loadYahooQuote(
  symbol: string,
  loaders: YahooQuoteLoaders,
): Promise<Quote> {
  const chart = await loaders.fetchChart(symbol, "1mo");
  const { meta, history } = chart;
  const { normalizedCurrency, currencyDivisor } = normalizeChartCurrency(chart);
  const quoteSupplement = await loaders.fetchQuoteSupplement(symbol, currencyDivisor);
  const latest = history[history.length - 1]!;
  const prev = history.length > 1 ? history[history.length - 2]!.close : meta.chartPreviousClose;
  const price = meta.regularMarketPrice ?? latest.close;
  const change = prev != null ? price - prev : 0;

  const marketState = deriveMarketState(meta);
  const extendedHoursBase = quoteSupplement.previousClose ?? prev;
  const extHours = await loaders.fetchExtendedHoursData(
    symbol,
    meta,
    extendedHoursBase == null ? undefined : extendedHoursBase * currencyDivisor,
  );
  if (currencyDivisor !== 1) {
    normalizeExtendedHoursPrices(extHours, currencyDivisor);
  }

  return {
    symbol,
    providerId: loaders.providerId,
    price,
    currency: normalizedCurrency,
    change,
    changePercent: prev ? (change / prev) * 100 : 0,
    high52w: meta.fiftyTwoWeekHigh,
    low52w: meta.fiftyTwoWeekLow,
    name: meta.shortName || meta.longName,
    lastUpdated: yahooMarketTimestamp(meta),
    exchangeName: meta.exchangeName,
    fullExchangeName: meta.fullExchangeName,
    listingExchangeName: meta.exchangeName,
    listingExchangeFullName: meta.fullExchangeName,
    marketState,
    sessionConfidence: "derived",
    dataSource: "delayed",
    ...quoteSupplement,
    ...extHours,
  };
}

function yahooMarketTimestamp(meta: NonNullable<ChartResult["meta"]>): number {
  const marketTime = meta.regularMarketTime;
  if (typeof marketTime === "number" && Number.isFinite(marketTime) && marketTime > 0) {
    return marketTime < 1e12 ? marketTime * 1000 : marketTime;
  }
  return Date.now();
}
