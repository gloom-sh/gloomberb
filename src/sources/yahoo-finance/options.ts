import type { MarketDataRequestContext } from "../../types/data-provider";
import type { MarketState, OptionContract, OptionsChain, Quote } from "../../types/financials";
import { parseOptionSymbol } from "../../utils/options";
import { getYahooSymbolsToTry } from "./symbols";

type YahooFetchJsonWithCrumb = <T>(url: string) => Promise<T>;

interface LoadYahooOptionsChainOptions {
  exchange: string;
  expirationDate?: number;
  fetchJsonWithCrumb: YahooFetchJsonWithCrumb;
  ticker: string;
}

interface GetYahooOptionQuoteOptions {
  context?: MarketDataRequestContext;
  getOptionsChainResult: (
    ticker: string,
    exchange?: string,
    expirationDate?: number,
    context?: MarketDataRequestContext,
  ) => Promise<YahooOptionsChainResult>;
  providerId: string;
  ticker: string;
}

export interface YahooOptionsChainResult {
  chain: OptionsChain;
  underlyingMarketState?: MarketState;
}

const MARKET_STATES = new Set<MarketState>([
  "PRE",
  "REGULAR",
  "POST",
  "PREPRE",
  "POSTPOST",
  "CLOSED",
]);

function normalizeYahooMarketState(value: unknown): MarketState | undefined {
  const normalized = typeof value === "string" ? value.toUpperCase() as MarketState : undefined;
  return normalized && MARKET_STATES.has(normalized) ? normalized : undefined;
}

function deriveOptionMarketState(underlyingMarketState?: MarketState): MarketState | undefined {
  if (!underlyingMarketState) return undefined;
  return underlyingMarketState === "REGULAR" ? "REGULAR" : "CLOSED";
}

function mapYahooOptionContract(raw: Record<string, any>): OptionContract {
  return {
    contractSymbol: raw.contractSymbol ?? "",
    strike: raw.strike ?? 0,
    currency: raw.currency ?? "USD",
    lastPrice: raw.lastPrice ?? 0,
    change: raw.change ?? 0,
    percentChange: raw.percentChange ?? 0,
    volume: raw.volume ?? 0,
    openInterest: raw.openInterest ?? 0,
    bid: raw.bid ?? 0,
    ask: raw.ask ?? 0,
    impliedVolatility: raw.impliedVolatility ?? 0,
    inTheMoney: raw.inTheMoney ?? false,
    expiration: raw.expiration ?? 0,
    lastTradeDate: raw.lastTradeDate ?? 0,
  };
}

export async function loadYahooOptionsChainResult({
  exchange,
  expirationDate,
  fetchJsonWithCrumb,
  ticker,
}: LoadYahooOptionsChainOptions): Promise<YahooOptionsChainResult> {
  const symbolsToTry = getYahooSymbolsToTry(ticker, exchange);
  let lastError: any;

  for (const symbol of symbolsToTry) {
    try {
      let url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
      if (expirationDate != null) url += `?date=${expirationDate}`;

      const data = await fetchJsonWithCrumb<{
        optionChain?: {
          result?: Array<{
            underlyingSymbol?: string;
            expirationDates?: number[];
            quote?: { marketState?: unknown };
            options?: Array<{
              calls?: Array<Record<string, any>>;
              puts?: Array<Record<string, any>>;
            }>;
          }>;
        };
      }>(url);

      const result = data.optionChain?.result?.[0];
      if (!result) throw new Error("No options data");

      const opts = result.options?.[0];
      return {
        chain: {
          underlyingSymbol: result.underlyingSymbol ?? symbol,
          expirationDates: result.expirationDates ?? [],
          calls: (opts?.calls ?? []).map((contract) => mapYahooOptionContract(contract)),
          puts: (opts?.puts ?? []).map((contract) => mapYahooOptionContract(contract)),
          dataSource: "delayed",
          feed: "yahoo",
          delayMinutes: 15,
          realtimeEligible: false,
          asOf: new Date().toISOString(),
        },
        underlyingMarketState: normalizeYahooMarketState(result.quote?.marketState),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error(`No options chain for ${ticker}`);
}

export async function loadYahooOptionsChain(
  options: LoadYahooOptionsChainOptions,
): Promise<OptionsChain> {
  return (await loadYahooOptionsChainResult(options)).chain;
}

export async function getYahooOptionQuote({
  context,
  getOptionsChainResult,
  providerId,
  ticker,
}: GetYahooOptionQuoteOptions): Promise<Quote> {
  const parsed = parseOptionSymbol(ticker);
  if (!parsed) throw new Error(`Unsupported option symbol ${ticker}`);
  const { chain, underlyingMarketState } = await getOptionsChainResult(
    parsed.underlying,
    "",
    parsed.expTs,
    context,
  );
  const contracts = parsed.side === "C" ? chain.calls : chain.puts;
  const contract = contracts.find((candidate) =>
    Math.abs(candidate.strike - parsed.strike) < 0.001 &&
    candidate.expiration === parsed.expTs
  );
  if (!contract) throw new Error(`No option contract for ${ticker}`);

  const mark = contract.bid > 0 && contract.ask > 0
    ? (contract.bid + contract.ask) / 2
    : contract.bid > 0
      ? contract.bid
      : contract.ask > 0
        ? contract.ask
        : undefined;
  const marketState = deriveOptionMarketState(underlyingMarketState);
  const lastUpdated = mark != null
    ? Date.now()
    : contract.lastTradeDate > 0
      ? contract.lastTradeDate * 1000
      : Date.now();
  return {
    symbol: ticker,
    providerId,
    price: mark ?? contract.lastPrice,
    currency: contract.currency || "USD",
    change: contract.change,
    changePercent: contract.percentChange,
    volume: contract.volume,
    bid: contract.bid,
    ask: contract.ask,
    mark,
    name: contract.contractSymbol,
    lastUpdated,
    exchangeName: "OPTIONS",
    fullExchangeName: "OPTIONS",
    listingExchangeName: "OPTIONS",
    listingExchangeFullName: "OPTIONS",
    marketState,
    sessionConfidence: marketState ? "derived" : "unknown",
    dataSource: "delayed",
  };
}
