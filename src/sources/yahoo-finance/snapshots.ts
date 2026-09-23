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
import { latestFinancialPeriod } from "../../utils/latest-financial-period";
import { isShopOperatingTarget } from "../../utils/operating-result";
import { yahooSecurityName } from "./names";

type YahooChartSnapshot = {
  meta: NonNullable<ChartResult["meta"]>;
  history: PricePoint[];
  missingCloses?: Date[];
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

const DAY_MS = 86_400_000;

/**
 * The close the regular-market price moved from: the row before the session
 * that regularMarketTime falls in, or the latest row when Yahoo has not added
 * that session's row yet. When Yahoo left a session between that row and the
 * current one without a close, the row is two sessions old, so the quote
 * summary's previous close is used instead.
 */
function previousSessionClose(
  { history, meta, missingCloses = [] }: YahooChartSnapshot,
  summaryPreviousClose: number | undefined,
): number | undefined {
  const time = (meta.regularMarketTime ?? Number.NaN) * 1000;
  const index = Number.isFinite(time) ? history.findLastIndex((point) => point.date.getTime() <= time) : -1;
  if (index < 0) return history.length > 1 ? history[history.length - 2]!.close : meta.chartPreviousClose;
  const completed = time >= history[index]!.date.getTime() + DAY_MS;
  const reference = completed ? history[index] : history[index - 1];
  if (!reference) return meta.chartPreviousClose;
  const sessionStart = completed ? time : history[index]!.date.getTime();
  const skipped = missingCloses.some((date) => (
    date.getTime() > reference.date.getTime()
    && date.getTime() < sessionStart
    && (!completed || date.getTime() + DAY_MS <= time)
  ));
  return skipped && summaryPreviousClose != null && summaryPreviousClose > 0 ? summaryPreviousClose : reference.close;
}

/**
 * Extended-hours moves are measured from the last completed regular session.
 * Yahoo can move regularMarketPrice with extended-hours trades, so it is only
 * that close while its time sits before pre-market or at the regular close.
 */
function extendedHoursReference(
  meta: YahooChartSnapshot["meta"],
  marketState: Quote["marketState"],
  fallback: number | undefined,
): number | undefined {
  const price = meta.regularMarketPrice;
  const time = meta.regularMarketTime;
  const period = meta.currentTradingPeriod;
  if (price == null || !(price > 0) || time == null) return fallback;
  if (marketState === "PRE" && period?.pre?.start != null && time <= period.pre.start) return price;
  const regular = period?.regular;
  if (marketState === "POST" && regular?.start != null && regular.end != null
    && time >= regular.start && time <= regular.end + 60) return price;
  return fallback;
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
  const prev = previousSessionClose(chart, quoteSupplement.previousClose);
  const change = prev != null ? currentPrice - prev : 0;
  const changePct = prev ? (change / prev) * 100 : 0;

  const marketState = deriveMarketState(meta);
  const extendedHoursBase = extendedHoursReference(meta, marketState, quoteSupplement.previousClose ?? prev);
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
    instrumentType: meta.instrumentType,
    providerId: loaders.providerId,
    price: currentPrice,
    currency: normalizedCurrency,
    change,
    changePercent: changePct,
    high52w: meta.fiftyTwoWeekHigh,
    low52w: meta.fiftyTwoWeekLow,
    marketCap: latest("trailingMarketCap"),
    name: yahooSecurityName(meta.shortName, meta.longName),
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

  const operatingOwnership = isShopOperatingTarget(symbol, meta.exchangeName ?? "") && normalizedCurrency === "USD";
  const annualStatements = buildYahooStatements(metrics, "annual", operatingOwnership);
  const quarterlyStatements = buildYahooStatements(metrics, "quarterly", operatingOwnership);
  // Annual summary metrics must describe one reporting period, even when a
  // provider omits a newer observation from an individual metric's series.
  const annual = latestFinancialPeriod(annualStatements, (statement) => statement.date);
  const revenue = annual?.totalRevenue;
  const netIncome = annual?.netIncome;
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
    eps: annual?.eps,
    operatingMargin: revenue && annual?.operatingIncome != null
      ? annual.operatingIncome / revenue
      : undefined,
    profitMargin: revenue && netIncome != null ? netIncome / revenue : undefined,
    return1Y: computeYahooReturn(history, 1),
    return3Y: computeYahooReturn(history, 3),
    sharesOutstanding: annual?.dilutedShares,
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
  const prev = previousSessionClose(chart, quoteSupplement.previousClose);
  const price = meta.regularMarketPrice ?? latest.close;
  const change = prev != null ? price - prev : 0;

  const marketState = deriveMarketState(meta);
  const extendedHoursBase = extendedHoursReference(meta, marketState, quoteSupplement.previousClose ?? prev);
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
    instrumentType: meta.instrumentType,
    providerId: loaders.providerId,
    price,
    currency: normalizedCurrency,
    change,
    changePercent: prev ? (change / prev) * 100 : 0,
    high52w: meta.fiftyTwoWeekHigh,
    low52w: meta.fiftyTwoWeekLow,
    name: yahooSecurityName(meta.shortName, meta.longName),
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
