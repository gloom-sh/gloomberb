import type { Quote, PricePoint, TickerFinancials, OptionsChain, CompanyProfile, HolderData, AnalystResearchData, CorporateActionsData } from "../types/financials";
import type { DataProvider, EarningsEvent, MarketDataRequestContext, NewsItem, SecFilingItem } from "../types/data-provider";
import type { TimeRange } from "../time-series/range";
import {
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "../time-series/resolution";
import type { InstrumentSearchResult } from "../types/instrument";
import { parseOptionSymbol } from "../utils/options";
import { SecEdgarClient } from "./sec-edgar";
import { mergeFinancialStatementRows } from "../utils/financial-statements";
import { YahooHttpClient } from "./yahoo-finance/http";
import {
  normalizeSubUnitCurrency,
} from "./yahoo-finance/mappers";
import { getYahooSymbol, getYahooSymbolsToTry } from "./yahoo-finance/symbols";
import type { ChartResult } from "./yahoo-finance/types";
import {
  fetchYahooAssetProfile,
  fetchYahooChart,
  fetchYahooExtendedHoursData,
  fetchYahooQuoteSupplement,
  fetchYahooTimeseries,
} from "./yahoo-finance/requests";
import {
  getYahooChartResolutionCapabilities,
  getYahooChartResolutionSupport,
  loadYahooPriceHistory,
  loadYahooPriceHistoryForResolution,
} from "./yahoo-finance/history";
import {
  getYahooOptionQuote,
  loadYahooOptionsChain,
  loadYahooOptionsChainResult,
} from "./yahoo-finance/options";
import {
  loadYahooAnalystResearch,
  loadYahooCorporateActions,
  loadYahooEarningsCalendar,
  loadYahooHolders,
} from "./yahoo-finance/quote-summary";
import {
  loadYahooQuote,
  loadYahooTickerFinancials,
} from "./yahoo-finance/snapshots";

const SEC_STATEMENT_SUPPLEMENT_EXCHANGES = new Set([
  "",
  "AMEX",
  "ARCA",
  "BATS",
  "BYX",
  "IEX",
  "NASDAQ",
  "NMS",
  "NYSE",
  "NYSEARCA",
  "OTC",
  "PINK",
]);

export class YahooFinanceClient implements DataProvider {
  readonly id = "yahoo";
  readonly name = "Yahoo Finance";

  private readonly secClient = new SecEdgarClient();

  constructor(private readonly http = new YahooHttpClient()) {}

  private shouldSupplementSecStatements(ticker: string, exchange: string, financials: TickerFinancials): boolean {
    if (!/^[A-Z0-9.-]+$/i.test(ticker.trim())) return false;
    if (ticker.includes(".")) return false;
    const normalizedExchange = exchange.trim().toUpperCase();
    return SEC_STATEMENT_SUPPLEMENT_EXCHANGES.has(normalizedExchange)
      && (financials.quote?.currency ?? "USD").toUpperCase() === "USD";
  }

  private async supplementSecStatements(
    ticker: string,
    exchange: string,
    financials: TickerFinancials,
  ): Promise<TickerFinancials> {
    if (!this.shouldSupplementSecStatements(ticker, exchange, financials)) return financials;
    try {
      const secStatements = await this.secClient.getFinancialStatements(ticker);
      if (
        !secStatements
        || (secStatements.annualStatements.length === 0 && secStatements.quarterlyStatements.length === 0)
      ) {
        return financials;
      }
      return {
        ...financials,
        annualStatements: mergeFinancialStatementRows(financials.annualStatements, secStatements.annualStatements),
        quarterlyStatements: mergeFinancialStatementRows(financials.quarterlyStatements, secStatements.quarterlyStatements),
      };
    } catch {
      return financials;
    }
  }

  private async fetchChart(symbol: string, range: string, interval = "1d", includePrePost = false) {
    return fetchYahooChart(this.http, symbol, range, interval, includePrePost);
  }

  /** Fetch extended hours data using 1d intraday chart with pre/post market included */
  private async fetchExtendedHoursData(
    symbol: string,
    meta: NonNullable<ChartResult["meta"]>,
    regularClose?: number,
  ) {
    return fetchYahooExtendedHoursData(this.http, symbol, meta, regularClose);
  }

  private async fetchTimeseries(symbol: string, types: string[], period1 = "2010-01-01") {
    return fetchYahooTimeseries(this.http, symbol, types, period1);
  }

  private async fetchAssetProfile(symbol: string): Promise<CompanyProfile | undefined> {
    return fetchYahooAssetProfile(this.http, symbol);
  }

  private async fetchQuoteSupplement(
    symbol: string,
    currencyDivisor = 1,
  ): Promise<Pick<Quote, "bid" | "ask" | "bidSize" | "askSize" | "previousClose" | "open" | "high" | "low">> {
    return fetchYahooQuoteSupplement(this.http, symbol, currencyDivisor);
  }

  /** Fetch full financials for a ticker */
  async getTickerFinancials(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<TickerFinancials> {
    const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
    let lastError: any;

    for (const symbol of symbolsToTry) {
      try {
        const result = await loadYahooTickerFinancials(symbol, {
          fetchAssetProfile: (targetSymbol) => this.fetchAssetProfile(targetSymbol),
          fetchChart: (targetSymbol, range, interval) => this.fetchChart(targetSymbol, range, interval),
          fetchExtendedHoursData: (targetSymbol, meta) => this.fetchExtendedHoursData(targetSymbol, meta),
          fetchQuoteSupplement: (targetSymbol, currencyDivisor) =>
            this.fetchQuoteSupplement(targetSymbol, currencyDivisor),
          fetchTimeseries: (targetSymbol, types, period1) => this.fetchTimeseries(targetSymbol, types, period1),
          providerId: this.id,
        });
        return await this.supplementSecStatements(ticker, exchange, result);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`No data for ${ticker}`);
  }

  /** Fetch just a quote (lighter weight) */
  async getQuote(ticker: string, exchange = "", context?: MarketDataRequestContext): Promise<Quote> {
    if (parseOptionSymbol(ticker)) {
      return getYahooOptionQuote({
        context,
        getOptionsChainResult: (underlying, requestExchange, expirationDate) => (
          loadYahooOptionsChainResult({
            exchange: requestExchange ?? "",
            expirationDate,
            fetchJsonWithCrumb: (url) => this.http.fetchJsonWithCrumb(url),
            ticker: underlying,
          })
        ),
        providerId: this.id,
        ticker,
      });
    }

    const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
    let lastError: any;

    for (const symbol of symbolsToTry) {
      try {
        return await loadYahooQuote(symbol, {
          fetchChart: (targetSymbol, range, interval) => this.fetchChart(targetSymbol, range, interval),
          fetchExtendedHoursData: (targetSymbol, meta) => this.fetchExtendedHoursData(targetSymbol, meta),
          fetchQuoteSupplement: (targetSymbol, currencyDivisor) =>
            this.fetchQuoteSupplement(targetSymbol, currencyDivisor),
          providerId: this.id,
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`No quote for ${ticker}`);
  }

  /** Fetch exchange rate to USD */
  async getExchangeRate(fromCurrency: string): Promise<number> {
    // Normalize sub-unit currencies to their main unit
    const { currency: normalized } = normalizeSubUnitCurrency(fromCurrency);
    fromCurrency = normalized;
    if (fromCurrency === "USD") return 1;

    const { meta, history } = await this.fetchChart(`${fromCurrency}USD=X`, "1mo");
    const rate = meta.regularMarketPrice ?? history[history.length - 1]?.close;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`No exchange rate data for ${fromCurrency}/USD`);
    }
    return rate;
  }

  /** Search for a ticker by name/symbol - uses direct fetch (no retry) for speed */
  async search(query: string): Promise<InstrumentSearchResult[]> {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
    try {
      const resp = await fetch(url, {
        headers: this.http.defaultHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as any;
      return (data.quotes || []).map((q: any) => ({
        providerId: this.id,
        symbol: q.symbol || "",
        name: q.shortname || q.longname || "",
        exchange: q.exchDisp || q.exchange || "",
        type: q.quoteType || "",
      }));
    } catch {
      return [];
    }
  }

  /** Fetch news for a ticker */
  async getNews(ticker: string, count = 10, exchange = "", _context?: MarketDataRequestContext): Promise<NewsItem[]> {
    // Use the Yahoo symbol for better search results on international tickers
    const symbol = getYahooSymbol(ticker, exchange);
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${count}`;
    try {
      const resp = await fetch(url, {
        headers: this.http.defaultHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as any;
      const items: NewsItem[] = (data.news || []).map((n: any) => ({
        title: n.title || "",
        url: n.link || "",
        source: n.publisher || "",
        publishedAt: new Date((n.providerPublishTime || 0) * 1000),
        summary: n.summary || undefined,
      }));

      return items;
    } catch {
      return [];
    }
  }

  async getHolders(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<HolderData> {
    return loadYahooHolders({
      exchange,
      fetchJsonWithCrumb: (url) => this.http.fetchJsonWithCrumb(url),
      providerId: this.id,
      ticker,
    });
  }

  async getAnalystResearch(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<AnalystResearchData> {
    return loadYahooAnalystResearch({
      exchange,
      fetchJsonWithCrumb: (url) => this.http.fetchJsonWithCrumb(url),
      providerId: this.id,
      ticker,
    });
  }

  async getCorporateActions(ticker: string, exchange = "", _context?: MarketDataRequestContext): Promise<CorporateActionsData> {
    return loadYahooCorporateActions({
      exchange,
      fetchChart: (symbol, range, interval) => this.fetchChart(symbol, range, interval),
      fetchJsonWithCrumb: (url) => this.http.fetchJsonWithCrumb(url),
      providerId: this.id,
      ticker,
    });
  }

  async getSecFilings(ticker: string, count = 10, _exchange = "", _context?: MarketDataRequestContext): Promise<SecFilingItem[]> {
    return this.secClient.getRecentFilings(ticker, count);
  }

  async getSecFilingDocuments(filing: SecFilingItem) {
    return this.secClient.getFilingDocuments(filing);
  }

  async getSecFilingContent(filing: SecFilingItem): Promise<string | null> {
    return this.secClient.getFilingContent(filing);
  }

  /** Fetch article summary by scraping og:description from the article page */
  async getArticleSummary(url: string): Promise<string | null> {
    try {
      const resp = await fetch(url, {
        headers: {
          ...this.http.defaultHeaders(),
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      if (!resp.ok) return null;
      const html = await resp.text();
      // Extract og:description content
      const match = html.match(/og:description"\s+content="([^"]*?)"/);
      if (!match?.[1]) return null;
      // Decode HTML entities
      return match[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
    } catch {
      return null;
    }
  }

  /** Fetch price history with appropriate granularity for the given time range */
  getChartResolutionSupport(): ChartResolutionSupport[] {
    return getYahooChartResolutionSupport();
  }

  getChartResolutionCapabilities(): ManualChartResolution[] {
    return getYahooChartResolutionCapabilities();
  }

  async getPriceHistory(ticker: string, exchange = "", range: TimeRange, _context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return loadYahooPriceHistory({
      ticker,
      exchange,
      range,
      fetchChart: (symbol, chartRange, interval) => this.fetchChart(symbol, chartRange, interval),
    });
  }

  async getPriceHistoryForResolution(
    ticker: string,
    exchange = "",
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    _context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    return loadYahooPriceHistoryForResolution({
      ticker,
      exchange,
      bufferRange,
      resolution,
      fetchChart: (symbol, chartRange, interval) => this.fetchChart(symbol, chartRange, interval),
    });
  }

  // ── Options Chain ──────────────────────────────────────────────────

  async getOptionsChain(ticker: string, exchange = "", expirationDate?: number, _context?: MarketDataRequestContext): Promise<OptionsChain> {
    return loadYahooOptionsChain({
      exchange,
      expirationDate,
      fetchJsonWithCrumb: (url) => this.http.fetchJsonWithCrumb(url),
      ticker,
    });
  }

  async getEarningsCalendar(symbols: string[], _context?: MarketDataRequestContext): Promise<EarningsEvent[]> {
    return loadYahooEarningsCalendar(symbols, (url) => this.http.fetchJsonWithCrumb(url));
  }
}
