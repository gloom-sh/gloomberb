import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { BrokerPosition } from "../types/broker";
import type { BrokerInstanceConfig } from "../types/config";
import type { BrokerContractRef } from "../types/instrument";
import type { TickerMetadata, TickerPosition, TickerRecord } from "../types/ticker";

export async function loadTickerMap(
  tickerRepository: AppTickerRepositoryPort,
  existingTickers?: Map<string, TickerRecord>,
): Promise<Map<string, TickerRecord>> {
  if (existingTickers) {
    return new Map(existingTickers);
  }

  const tickers = await tickerRepository.loadAllTickers();
  return new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker] as const));
}

function mergeBrokerContracts(existing: BrokerContractRef[], next: BrokerContractRef[]): BrokerContractRef[] {
  const merged = new Map<string, BrokerContractRef>();
  for (const contract of [...existing, ...next]) {
    const key = `${contract.brokerId}:${contract.brokerInstanceId ?? ""}:${contract.conId ?? contract.localSymbol ?? contract.symbol}:${contract.secType ?? ""}`;
    merged.set(key, contract);
  }
  return [...merged.values()];
}

function buildPositionEntry(
  instance: BrokerInstanceConfig,
  portfolioId: string,
  position: BrokerPosition,
  brokerContract?: BrokerContractRef,
): TickerPosition {
  return {
    portfolio: portfolioId,
    shares: position.shares,
    avgCost: position.avgCost ?? 0,
    currency: position.currency,
    broker: instance.brokerType,
    side: position.side,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
    multiplier: position.multiplier,
    markPrice: position.markPrice,
    brokerInstanceId: instance.id,
    brokerAccountId: position.accountId,
    brokerContractId: brokerContract?.conId,
  };
}

function createTickerMetadata(
  position: BrokerPosition,
  portfolioId: string,
  positionEntry: TickerPosition,
  brokerContract?: BrokerContractRef,
): TickerMetadata {
  return {
    ticker: position.ticker,
    exchange: position.exchange,
    currency: position.currency,
    name: position.name || position.ticker,
    assetCategory: position.assetCategory,
    isin: position.isin,
    portfolios: [portfolioId],
    watchlists: [],
    positions: [positionEntry],
    broker_contracts: brokerContract ? [brokerContract] : [],
    custom: {},
    tags: [],
  };
}

function updateExistingTicker(
  ticker: TickerRecord,
  instance: BrokerInstanceConfig,
  portfolioId: string,
  position: BrokerPosition,
  positionEntry: TickerPosition,
  brokerContract?: BrokerContractRef,
): TickerRecord {
  const otherPositions = ticker.metadata.positions.filter(
    (entry) => !(entry.portfolio === portfolioId && entry.broker === instance.brokerType),
  );
  const brokerContracts = mergeBrokerContracts(
    ticker.metadata.broker_contracts ?? [],
    brokerContract ? [brokerContract] : [],
  );
  const portfolios = ticker.metadata.portfolios.includes(portfolioId)
    ? ticker.metadata.portfolios
    : [...ticker.metadata.portfolios, portfolioId];

  return {
    ...ticker,
    metadata: {
      ...ticker.metadata,
      name: position.name && ticker.metadata.name === ticker.metadata.ticker
        ? position.name
        : ticker.metadata.name,
      assetCategory: position.assetCategory && !ticker.metadata.assetCategory
        ? position.assetCategory
        : ticker.metadata.assetCategory,
      isin: position.isin && !ticker.metadata.isin ? position.isin : ticker.metadata.isin,
      positions: [...otherPositions, positionEntry],
      broker_contracts: brokerContracts,
      portfolios,
    },
  };
}

export function upsertBrokerPositionTicker({
  tickers,
  instance,
  portfolioId,
  position,
}: {
  tickers: Map<string, TickerRecord>;
  instance: BrokerInstanceConfig;
  portfolioId: string;
  position: BrokerPosition;
}): { ticker: TickerRecord; created: boolean } {
  const brokerContract = position.brokerContract
    ? {
      ...position.brokerContract,
      brokerId: instance.brokerType,
      brokerInstanceId: instance.id,
    }
    : undefined;
  const positionEntry = buildPositionEntry(instance, portfolioId, position, brokerContract);
  const existingTicker = tickers.get(position.ticker);

  if (!existingTicker) {
    return {
      ticker: { metadata: createTickerMetadata(position, portfolioId, positionEntry, brokerContract) },
      created: true,
    };
  }

  const ticker = updateExistingTicker(existingTicker, instance, portfolioId, position, positionEntry, brokerContract);
  return { ticker, created: false };
}
