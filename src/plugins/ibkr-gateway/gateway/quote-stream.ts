import {
  EventName,
  MarketDataType,
  type Contract,
  type ContractDetails,
  type IBApiNext,
  type MarketDataUpdate,
} from "@stoqey/ib";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import {
  applyTickByTickAllLastToQuote,
  applyTickByTickBidAskToQuote,
  hasDelayedMarketData,
  marketDataToQuote,
  type TickByTickAllLast,
  type TickByTickBidAskUpdate,
} from "./market-data";
import { IBKR_DATA_TIMEOUT, withTimeout } from "./timeouts";

export type QuoteStreamListener = (target: QuoteSubscriptionTarget, quote: Quote) => void;

export interface ActiveQuoteStream {
  target: QuoteSubscriptionTarget;
  listeners: Map<QuoteStreamListener, QuoteSubscriptionTarget>;
  stop: () => void;
  lastQuote?: Quote;
}

export const IBKR_QUOTE_STREAM_TICKS = "165,221,233";

function emitQuoteToStream(stream: ActiveQuoteStream, quote: Quote): void {
  stream.lastQuote = quote;
  for (const [listener, listenerTarget] of stream.listeners.entries()) {
    listener(listenerTarget, quote);
  }
}

type IbkrMarketDataSnapshot = Parameters<typeof hasDelayedMarketData>[0];

function quoteDataSource(marketData: IbkrMarketDataSnapshot, activeMarketDataType: MarketDataType): "live" | "delayed" {
  return hasDelayedMarketData(marketData) || activeMarketDataType !== MarketDataType.REALTIME
    ? "delayed"
    : "live";
}

export function applyMarketDataQuoteStreamUpdate(
  stream: ActiveQuoteStream | undefined,
  contract: Contract,
  details: ContractDetails,
  update: MarketDataUpdate,
  activeMarketDataType: MarketDataType,
): void {
  if (!stream || stream.listeners.size === 0) return;

  try {
    const quote = marketDataToQuote(contract, details, update.all);
    quote.providerId = "ibkr";
    quote.dataSource = quoteDataSource(update.all, activeMarketDataType);
    emitQuoteToStream(stream, quote);
  } catch {
    // Ignore partial tick snapshots until IBKR has sent a usable quote.
  }
}

export function applyTickByTickAllLastStreamUpdate(
  stream: ActiveQuoteStream | undefined,
  contract: Contract,
  details: ContractDetails,
  tick: TickByTickAllLast,
  priceDivisor: number,
  activeMarketDataType: MarketDataType,
): void {
  if (!stream || stream.listeners.size === 0) return;

  const nextQuote = applyTickByTickAllLastToQuote(
    stream.lastQuote,
    contract,
    details,
    tick,
    priceDivisor,
    stream.lastQuote?.dataSource ?? (activeMarketDataType === MarketDataType.REALTIME ? "live" : "delayed"),
  );
  if (nextQuote) emitQuoteToStream(stream, nextQuote);
}

export function applyTickByTickBidAskStreamUpdate(
  stream: ActiveQuoteStream | undefined,
  update: TickByTickBidAskUpdate,
  priceDivisor: number,
): void {
  if (!stream || stream.listeners.size === 0) return;
  const nextQuote = applyTickByTickBidAskToQuote(stream.lastQuote, update, priceDivisor);
  if (nextQuote) emitQuoteToStream(stream, nextQuote);
}

export async function loadIbkrSeedQuote({
  api,
  activeMarketDataType,
  contract,
  details,
  withMarketDataFallback,
}: {
  api: IBApiNext;
  activeMarketDataType: MarketDataType;
  contract: Contract;
  details: ContractDetails;
  withMarketDataFallback<T>(operation: () => Promise<T>): Promise<T>;
}): Promise<Quote | null> {
  try {
    const marketData = await withMarketDataFallback(
      () => withTimeout(api.getMarketDataSnapshot(contract, "", false), IBKR_DATA_TIMEOUT, "getMarketDataSnapshot"),
    );
    const quote = marketDataToQuote(contract, details, marketData);
    quote.providerId = "ibkr";
    quote.dataSource = quoteDataSource(marketData as IbkrMarketDataSnapshot, activeMarketDataType);
    return quote;
  } catch {
    return null;
  }
}

export function startIbkrTickByTickBidAskStream({
  api,
  rawApi,
  contract,
  onUpdate,
  onError,
}: {
  api: IBApiNext;
  rawApi: any;
  contract: Contract;
  onUpdate: (update: TickByTickBidAskUpdate) => void;
  onError: (message: string) => void;
}): () => void {
  const reqId = (api as any)?.nextReqId;
  if (typeof reqId !== "number" || !Number.isFinite(reqId)) {
    onError("No request id available for tick-by-tick bid/ask stream");
    return () => {};
  }

  const handleBidAsk = (
    incomingReqId: number,
    time: number,
    bidPrice: number,
    askPrice: number,
    bidSize: number,
    askSize: number,
  ) => {
    if (incomingReqId !== reqId) return;
    onUpdate({ time, bidPrice, askPrice, bidSize, askSize });
  };
  const handleError = (error: Error, code: number, incomingReqId: number) => {
    if (incomingReqId !== reqId) return;
    onError(error?.message || `IBKR error ${code}`);
  };

  rawApi.on(EventName.tickByTickBidAsk, handleBidAsk);
  rawApi.on(EventName.error, handleError);
  rawApi.reqTickByTickData(reqId, contract, "BidAsk", 0, false);

  return () => {
    rawApi.off(EventName.tickByTickBidAsk, handleBidAsk);
    rawApi.off(EventName.error, handleError);
    try {
      rawApi.cancelTickByTickData(reqId);
    } catch {
      // ignore shutdown races
    }
  };
}
