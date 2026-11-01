import type { TimeRange } from "../time-series/range";
import type { ManualChartResolution } from "../time-series/resolution";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import type { BrokerContractRef } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";
import { brokerContractIdentityKey, scopedBrokerContractIdentityKey } from "../utils/instrument-identity";

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
): BrokerContractRef | null | undefined {
  const contracts = ticker?.metadata.broker_contracts ?? [];
  const portfolioId = options.portfolioId;
  if (portfolioId) {
    // Rows ask on every render of a list: nothing is allocated for a portfolio's lots until one names a contract.
    let selected: Map<string, BrokerContractRef> | null = null;
    let hasPublicPosition = false;
    for (const position of ticker?.metadata.positions ?? []) {
      if (position.portfolio !== portfolioId || position.shares === 0) continue;
      const hasExplicitId = position.brokerContractId != null;
      const hasExplicitIdentity = position.brokerContractIdentity != null;
      const hasLegacyScope = position.broker !== "manual" && !!position.broker && !!position.brokerInstanceId;
      if (!hasExplicitId && !hasExplicitIdentity && !hasLegacyScope) {
        hasPublicPosition = true;
        continue;
      }
      const matches = contracts.filter((contract) => (
        (position.brokerContractId == null || contract.conId === position.brokerContractId)
        && (hasExplicitId || !hasExplicitIdentity || brokerContractIdentityKey(contract) === position.brokerContractIdentity)
        && (!position.brokerInstanceId || contract.brokerInstanceId === position.brokerInstanceId)
        && (!position.broker || contract.brokerId === position.broker)
      ));
      if (matches.length === 0) {
        if (hasExplicitId || hasExplicitIdentity) return undefined;
        hasPublicPosition = true;
        continue;
      }
      selected ??= new Map();
      for (const contract of matches) {
        const key = scopedBrokerContractIdentityKey(contract);
        selected.set(key, contract);
      }
    }
    if (!selected) return null;
    // One ticker quote must identify every selected lot. Never choose by array order.
    if (selected.size > 1 || (selected.size > 0 && hasPublicPosition)) return undefined;
    return selected.values().next().value ?? null;
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
  if (instrument === undefined) return null;
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
