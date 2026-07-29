import type { TimeRange } from "../time-series/range";
import type { ManualChartResolution } from "../time-series/resolution";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import type { BrokerContractRef } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";

export interface InstrumentRef {
  symbol: string;
  exchange?: string;
  brokerId?: string;
  brokerInstanceId?: string;
  instrument?: BrokerContractRef | null;
}

export interface TickerInstrumentOptions {
  portfolioId?: string | null;
}

type ChartGranularity = "range" | "detail" | "resolution";

export interface ChartRequest {
  instrument: InstrumentRef;
  bufferRange: TimeRange;
  granularity?: ChartGranularity;
  resolution?: ManualChartResolution;
  startDate?: Date;
  endDate?: Date;
  barSize?: string;
}

export interface OptionsRequest {
  instrument: InstrumentRef;
  expirationDate?: number;
}

export interface SecFilingsRequest {
  instrument: InstrumentRef;
  count?: number;
}

function brokerContractForTicker(
  ticker: TickerRecord | null | undefined,
  options: TickerInstrumentOptions = {},
): BrokerContractRef | null {
  const contracts = ticker?.metadata.broker_contracts ?? [];
  if (contracts.length === 0) return null;

  const portfolioId = options.portfolioId;
  if (portfolioId) {
    const positions = ticker?.metadata.positions.filter((position) => position.portfolio === portfolioId) ?? [];
    for (const position of positions) {
      const matchingContract = contracts.find((contract) => (
        (position.brokerContractId == null || contract.conId === position.brokerContractId)
        && (!position.brokerInstanceId || contract.brokerInstanceId === position.brokerInstanceId)
        && (!position.broker || contract.brokerId === position.broker)
      ));
      if (matchingContract) return matchingContract;
    }
    for (const position of positions) {
      const matchingContract = contracts.find((contract) => (
        (!position.brokerInstanceId || contract.brokerInstanceId === position.brokerInstanceId)
        && (!position.broker || contract.brokerId === position.broker)
      ));
      if (matchingContract) return matchingContract;
    }
  }

  return contracts[0] ?? null;
}

export function instrumentFromTicker(
  ticker: TickerRecord | null | undefined,
  fallbackSymbol?: string | null,
  options: TickerInstrumentOptions = {},
): InstrumentRef | null {
  const symbol = ticker?.metadata.ticker ?? fallbackSymbol ?? null;
  if (!symbol) return null;
  const instrument = brokerContractForTicker(ticker, options);
  return {
    symbol,
    exchange: ticker?.metadata.exchange ?? "",
    brokerId: instrument?.brokerId,
    brokerInstanceId: instrument?.brokerInstanceId,
    instrument,
  };
}

export function quoteSubscriptionTargetFromTicker(
  ticker: TickerRecord | null | undefined,
  fallbackSymbol?: string | null,
  route: QuoteSubscriptionTarget["route"] = "auto",
  options: TickerInstrumentOptions = {},
): QuoteSubscriptionTarget | null {
  const instrument = instrumentFromTicker(ticker, fallbackSymbol, options);
  return quoteSubscriptionTargetFromInstrument(instrument, route);
}

function quoteSubscriptionTargetFromInstrument(
  instrument: InstrumentRef | null | undefined,
  route: QuoteSubscriptionTarget["route"] = "auto",
): QuoteSubscriptionTarget | null {
  if (!instrument) return null;
  return {
    symbol: instrument.symbol,
    exchange: instrument.exchange,
    route,
    context: {
      brokerId: instrument.brokerId,
      brokerInstanceId: instrument.brokerInstanceId,
      instrument: instrument.instrument ?? null,
    },
  };
}
