import {
  WhatToShow,
  type Contract,
  type ContractDetails,
  type IBApiNext,
} from "@stoqey/ib";
import type { TimeRange } from "gloomberb/time-series";
import type { ManualChartResolution } from "gloomberb/time-series";
import type { PricePoint } from "gloomberb/types/financials";
import type { BrokerContractRef } from "gloomberb/types/instrument";
import {
  formatIbkrHistoricalEndDateTime,
  getIbkrHistoryDuration,
  ibkrHistoricalBarsToPricePoints,
  IBKR_GENERIC_BAR_SIZE_MAP,
  IBKR_HISTORY_PARAMS,
} from "./history";
import { IBKR_DATA_TIMEOUT, withTimeout } from "./timeouts";
import { getIbkrPriceDivisor } from "./price-normalization";

export interface IbkrHistoryRequestContext {
  api: IBApiNext;
  resolveContract(ticker: string, exchange: string, instrument: BrokerContractRef | null): Promise<Contract>;
  getPrimaryContractDetails(contract: Contract): Promise<ContractDetails>;
  withMarketDataFallback<T>(operation: () => Promise<T>): Promise<T>;
}

async function resolveHistoryContract(
  context: IbkrHistoryRequestContext,
  ticker: string,
  exchange: string,
  instrument: BrokerContractRef | null,
) {
  const contract = await withTimeout(
    context.resolveContract(ticker, exchange, instrument),
    IBKR_DATA_TIMEOUT,
    "resolveContract",
  );
  const detailsPromise = withTimeout(
    context.getPrimaryContractDetails(contract),
    IBKR_DATA_TIMEOUT,
    "getContractDetails",
  ).catch(() => undefined);
  return { contract, detailsPromise };
}

export async function loadIbkrPriceHistory(
  context: IbkrHistoryRequestContext,
  {
    ticker,
    exchange,
    range,
    instrument,
  }: {
    ticker: string;
    exchange: string;
    range: TimeRange;
    instrument?: BrokerContractRef | null;
  },
): Promise<PricePoint[]> {
  const { contract, detailsPromise } = await resolveHistoryContract(context, ticker, exchange, instrument ?? null);
  const params = IBKR_HISTORY_PARAMS[range];
  const bars = await context.withMarketDataFallback(
    () => withTimeout(context.api.getHistoricalData(
      contract,
      "",
      params.duration,
      params.size,
      WhatToShow.TRADES,
      1,
      1,
    ), IBKR_DATA_TIMEOUT, "getHistoricalData"),
  );
  const details = await detailsPromise;
  const priceDivisor = getIbkrPriceDivisor(contract, details);

  return ibkrHistoricalBarsToPricePoints(bars, priceDivisor);
}

export async function loadIbkrPriceHistoryForResolution(
  context: IbkrHistoryRequestContext,
  {
    ticker,
    exchange,
    bufferRange,
    resolution,
    instrument,
  }: {
    ticker: string;
    exchange: string;
    bufferRange: TimeRange;
    resolution: ManualChartResolution;
    instrument?: BrokerContractRef | null;
  },
): Promise<PricePoint[]> {
  const ibkrBarSize = IBKR_GENERIC_BAR_SIZE_MAP[resolution];
  if (!ibkrBarSize) return [];

  const { contract, detailsPromise } = await resolveHistoryContract(context, ticker, exchange, instrument ?? null);
  const params = IBKR_HISTORY_PARAMS[bufferRange];
  const bars = await context.withMarketDataFallback(
    () => withTimeout(context.api.getHistoricalData(
      contract,
      "",
      params.duration,
      ibkrBarSize,
      WhatToShow.TRADES,
      1,
      1,
    ), IBKR_DATA_TIMEOUT, "getHistoricalData"),
  );
  const details = await detailsPromise;
  const priceDivisor = getIbkrPriceDivisor(contract, details);

  return ibkrHistoricalBarsToPricePoints(bars, priceDivisor);
}

export async function loadIbkrDetailedPriceHistory(
  context: IbkrHistoryRequestContext,
  {
    ticker,
    exchange,
    startDate,
    endDate,
    barSize,
    instrument,
  }: {
    ticker: string;
    exchange: string;
    startDate: Date;
    endDate: Date;
    barSize: string;
    instrument?: BrokerContractRef | null;
  },
): Promise<PricePoint[]> {
  const ibkrBarSize = IBKR_GENERIC_BAR_SIZE_MAP[barSize as ManualChartResolution];
  if (!ibkrBarSize) return [];

  const { contract, detailsPromise } = await resolveHistoryContract(context, ticker, exchange, instrument ?? null);
  const endDateTime = formatIbkrHistoricalEndDateTime(endDate);
  const durationStr = getIbkrHistoryDuration(startDate, endDate);

  const bars = await context.withMarketDataFallback(
    () => withTimeout(context.api.getHistoricalData(
      contract,
      endDateTime,
      durationStr,
      ibkrBarSize,
      WhatToShow.TRADES,
      1,
      1,
    ), IBKR_DATA_TIMEOUT, "getDetailedHistoricalData"),
  );
  const details = await detailsPromise;
  const priceDivisor = getIbkrPriceDivisor(contract, details);

  return ibkrHistoricalBarsToPricePoints(bars, priceDivisor);
}
