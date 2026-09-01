import {
  IBApiTickType,
  MarketDataType,
  type Contract,
  type ContractDetails,
} from "@stoqey/ib";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { normalizeSymbol } from "../../../utils/exchanges";
import type { IbkrGatewayConfig } from "./types";
import { getIbkrPriceDivisor, normalizeIbkrPriceValue } from "./price-normalization";

export interface TickByTickAllLast {
  time: number;
  price: number;
  size?: number;
  tickType?: number;
  tickAttribLast?: unknown;
  exchange?: string;
  specialConditions?: string;
  contract?: Contract;
}

export interface TickByTickBidAskUpdate {
  time: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
}

export function normalizeQuoteStreamTarget(target: QuoteSubscriptionTarget): QuoteSubscriptionTarget | null {
  const symbol = normalizeSymbol(target.symbol);
  if (!symbol) return null;
  return {
    ...target,
    symbol,
    exchange: target.exchange?.trim().toUpperCase() ?? "",
  };
}

export function buildQuoteStreamKey(target: QuoteSubscriptionTarget): string {
  const contractKey = target.context?.instrument?.conId
    ?? target.context?.instrument?.localSymbol
    ?? target.context?.instrument?.symbol
    ?? "";
  return [target.symbol, target.exchange ?? "", contractKey].join("|");
}

export function hasDelayedMarketData(
  marketData: ReadonlyMap<number, { value?: number; ingressTm: number }>,
): boolean {
  return [
    IBApiTickType.DELAYED_BID,
    IBApiTickType.DELAYED_ASK,
    IBApiTickType.DELAYED_LAST,
    IBApiTickType.DELAYED_BID_SIZE,
    IBApiTickType.DELAYED_ASK_SIZE,
    IBApiTickType.DELAYED_LAST_SIZE,
    IBApiTickType.DELAYED_HIGH,
    IBApiTickType.DELAYED_LOW,
    IBApiTickType.DELAYED_VOLUME,
    IBApiTickType.DELAYED_CLOSE,
    IBApiTickType.DELAYED_OPEN,
    IBApiTickType.DELAYED_LAST_TIMESTAMP,
  ].some((tickType) => marketData.has(tickType));
}

function firstNonSmartExchange(value?: string): string | undefined {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && entry !== "SMART");
}

function resolveIbkrListingExchange(
  current: Quote | undefined,
  contract: Contract,
  details: ContractDetails,
): string | undefined {
  return current?.listingExchangeName
    ?? contract.primaryExch
    ?? firstNonSmartExchange(details.validExchanges)
    ?? (current?.exchangeName !== "SMART" ? current?.exchangeName : undefined)
    ?? (contract.exchange !== "SMART" ? contract.exchange : undefined);
}

function resolveIbkrRoutingExchange(current: Quote | undefined, contract: Contract): string | undefined {
  return current?.routingExchangeName
    ?? contract.exchange
    ?? "SMART";
}

function ibkrVenueFields(
  current: Quote | undefined,
  contract: Contract,
  details: ContractDetails,
): Pick<
  Quote,
  | "exchangeName"
  | "fullExchangeName"
  | "listingExchangeName"
  | "listingExchangeFullName"
  | "routingExchangeName"
  | "routingExchangeFullName"
  | "marketState"
  | "sessionConfidence"
> {
  const listingExchangeName = resolveIbkrListingExchange(current, contract, details);
  const listingExchangeFullName = current?.listingExchangeFullName
    ?? current?.fullExchangeName
    ?? listingExchangeName;
  const routingExchangeName = resolveIbkrRoutingExchange(current, contract);
  const routingExchangeFullName = current?.routingExchangeFullName ?? routingExchangeName;

  return {
    exchangeName: listingExchangeName,
    fullExchangeName: listingExchangeFullName,
    listingExchangeName,
    listingExchangeFullName,
    routingExchangeName,
    routingExchangeFullName,
    marketState: current?.marketState,
    sessionConfidence: current?.sessionConfidence ?? "unknown",
  };
}

export function applyTickByTickAllLastToQuote(
  current: Quote | undefined,
  contract: Contract,
  details: ContractDetails,
  tick: TickByTickAllLast,
  priceDivisor: number,
  dataSource: Quote["dataSource"],
): Quote | null {
  const nextPrice = normalizeIbkrPriceValue(tick.price, priceDivisor);
  if (nextPrice == null || nextPrice <= 0) return null;

  const canInferPreviousClose = current?.price != null
    && current.change != null
    && (current.change !== 0 || current.changePercent !== 0);
  const inferredPreviousClose = current?.previousClose
    ?? (canInferPreviousClose ? current.price - current.change : undefined);
  const previousClose = inferredPreviousClose != null && Number.isFinite(inferredPreviousClose) && inferredPreviousClose > 0
    ? inferredPreviousClose
    : undefined;
  const change = previousClose != null ? nextPrice - previousClose : current?.change ?? 0;
  return {
    symbol: current?.symbol ?? contract.localSymbol ?? contract.symbol ?? "",
    providerId: "ibkr",
    price: nextPrice,
    currency: current?.currency ?? contract.currency ?? "USD",
    change,
    changePercent: previousClose ? (change / previousClose) * 100 : current?.changePercent ?? 0,
    previousClose,
    high52w: current?.high52w,
    low52w: current?.low52w,
    volume: current?.volume,
    name: current?.name ?? details.longName ?? details.marketName ?? contract.symbol,
    lastUpdated: tick.time ? tick.time * 1000 : Date.now(),
    ...ibkrVenueFields(current, contract, details),
    preMarketPrice: current?.preMarketPrice,
    preMarketChange: current?.preMarketChange,
    preMarketChangePercent: current?.preMarketChangePercent,
    postMarketPrice: current?.postMarketPrice,
    postMarketChange: current?.postMarketChange,
    postMarketChangePercent: current?.postMarketChangePercent,
    bid: current?.bid,
    ask: current?.ask,
    bidSize: current?.bidSize,
    askSize: current?.askSize,
    open: current?.open,
    high: current?.high,
    low: current?.low,
    mark: current?.mark,
    dataSource,
  };
}

export function applyTickByTickBidAskToQuote(
  current: Quote | undefined,
  update: TickByTickBidAskUpdate,
  priceDivisor: number,
): Quote | null {
  if (!current) return null;
  const bid = normalizeIbkrPriceValue(update.bidPrice, priceDivisor);
  const ask = normalizeIbkrPriceValue(update.askPrice, priceDivisor);
  return {
    ...current,
    bid: bid ?? current.bid,
    ask: ask ?? current.ask,
    bidSize: Number.isFinite(update.bidSize) && update.bidSize >= 0 ? update.bidSize : current.bidSize,
    askSize: Number.isFinite(update.askSize) && update.askSize >= 0 ? update.askSize : current.askSize,
    lastUpdated: update.time ? update.time * 1000 : current.lastUpdated,
  };
}

export function marketDataToQuote(
  contract: Contract,
  details: ContractDetails,
  marketData: ReadonlyMap<number, { value?: number; ingressTm: number }>,
): Quote {
  const priceDivisor = getIbkrPriceDivisor(contract, details);
  const mark = normalizeIbkrPriceValue(marketData.get(IBApiTickType.MARK_PRICE)?.value, priceDivisor);
  const last = normalizeIbkrPriceValue(
    marketData.get(IBApiTickType.LAST)?.value
    ?? marketData.get(IBApiTickType.DELAYED_LAST)?.value
    ?? marketData.get(IBApiTickType.MARK_PRICE)?.value
    ?? marketData.get(IBApiTickType.CLOSE)?.value,
    priceDivisor,
  );
  if (last == null || last <= 0) {
    throw new Error(`No valid market data for ${contract.symbol || contract.localSymbol || contract.conId}`);
  }
  const close = normalizeIbkrPriceValue(
    marketData.get(IBApiTickType.CLOSE)?.value
      ?? marketData.get(IBApiTickType.DELAYED_CLOSE)?.value
      ?? last,
    priceDivisor,
  ) ?? last;
  const change = last - close;
  const ingressTm = marketData.get(IBApiTickType.LAST)?.ingressTm
    ?? marketData.get(IBApiTickType.DELAYED_LAST)?.ingressTm
    ?? marketData.get(IBApiTickType.MARK_PRICE)?.ingressTm
    ?? Date.now();

  return {
    symbol: contract.localSymbol || contract.symbol || "",
    price: last,
    currency: contract.currency || "USD",
    change,
    changePercent: close ? (change / close) * 100 : 0,
    previousClose: close,
    high52w: normalizeIbkrPriceValue(marketData.get(IBApiTickType.HIGH_52_WEEK)?.value, priceDivisor),
    low52w: normalizeIbkrPriceValue(marketData.get(IBApiTickType.LOW_52_WEEK)?.value, priceDivisor),
    volume: marketData.get(IBApiTickType.VOLUME)?.value ?? marketData.get(IBApiTickType.DELAYED_VOLUME)?.value,
    name: details.longName || details.marketName || contract.symbol,
    lastUpdated: ingressTm,
    ...ibkrVenueFields(undefined, contract, details),
    bid: normalizeIbkrPriceValue(
      marketData.get(IBApiTickType.BID)?.value ?? marketData.get(IBApiTickType.DELAYED_BID)?.value,
      priceDivisor,
    ),
    ask: normalizeIbkrPriceValue(
      marketData.get(IBApiTickType.ASK)?.value ?? marketData.get(IBApiTickType.DELAYED_ASK)?.value,
      priceDivisor,
    ),
    bidSize: marketData.get(IBApiTickType.BID_SIZE)?.value ?? marketData.get(IBApiTickType.DELAYED_BID_SIZE)?.value,
    askSize: marketData.get(IBApiTickType.ASK_SIZE)?.value ?? marketData.get(IBApiTickType.DELAYED_ASK_SIZE)?.value,
    open: normalizeIbkrPriceValue(
      marketData.get(IBApiTickType.OPEN)?.value ?? marketData.get(IBApiTickType.DELAYED_OPEN)?.value,
      priceDivisor,
    ),
    high: normalizeIbkrPriceValue(
      marketData.get(IBApiTickType.HIGH)?.value ?? marketData.get(IBApiTickType.DELAYED_HIGH)?.value,
      priceDivisor,
    ),
    low: normalizeIbkrPriceValue(
      marketData.get(IBApiTickType.LOW)?.value ?? marketData.get(IBApiTickType.DELAYED_LOW)?.value,
      priceDivisor,
    ),
    mark,
  };
}

export function marketDataTypeFromConfig(config?: IbkrGatewayConfig): MarketDataType {
  switch (config?.marketDataType) {
    case "frozen":
      return MarketDataType.FROZEN;
    case "delayed":
      return MarketDataType.DELAYED;
    case "delayed-frozen":
      return MarketDataType.DELAYED_FROZEN;
    case "live":
      return MarketDataType.REALTIME;
    case "auto":
    default:
      // Start with realtime; withMarketDataFallback will downgrade to delayed
      // if the account lacks live market data subscriptions.
      return MarketDataType.REALTIME;
  }
}

export function isMarketDataPermissionError(code: number | undefined, message: string | undefined): boolean {
  if (code === 354 || code === 10167) return true;
  const text = (message || "").toLowerCase();
  return text.includes("displaying delayed market data")
    || text.includes("delayed market data is available")
    || text.includes("market data connections")
    || text.includes("requested market data is not subscribed")
    || text.includes("requested market data requires additional subscription")
    || text.includes("market data subscription");
}

export function isIbInformationalWarning(code: number | undefined, message: string | undefined): boolean {
  if (code != null && [1102, 2104, 2106, 2107, 2108, 2158].includes(code)) {
    return true;
  }

  const text = (message || "").toLowerCase();
  return text.includes("connection is ok")
    || text.includes("connectivity between ib and trader workstation has been restored")
    || text.includes("inactive but should be available upon demand")
    || text.includes("sec-def data farm connection is ok")
    || text.includes("market data farm connection is ok")
    || text.includes("hmds data farm connection is ok");
}

export function getIbErrorCode(error: any): number | undefined {
  const candidates = [
    error?.errorCode,
    error?.code,
    error?.error?.errorCode,
    error?.error?.code,
    error?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function getIbErrorMessage(error: any): string | undefined {
  const candidates = [
    error?.error?.message,
    error?.message,
    error?.error?.toString?.(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return undefined;
}

export function isClientIdInUseError(code: number | undefined, message: string | undefined): boolean {
  if (code === 326) return true;
  const text = (message || "").toLowerCase();
  return text.includes("client id is already in use")
    || text.includes("clientid is already in use")
    || text.includes("client id already in use");
}
