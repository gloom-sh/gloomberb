import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, TickerFinancials } from "../../../types/financials";
import { errorMessage } from "../../../utils/errors";
import { loadShortInterest, type ShortInterestResult } from "./client";
import { type CurrentFloat, type SettlementFloatStatistics, withPercentFloat } from "./model";
import { buildShortWatchRow, type ShortWatchRow } from "./watch-model";
import type { ShortInterestRecord } from "./types";

const CONCURRENCY = 6;

export interface ShortWatchDependencies {
  loadRecords(symbol: string): Promise<ShortInterestRecord[]>;
  loadSnapshots(instruments: InstrumentRef[], options?: { forceRefresh?: boolean }): Promise<QueryEntry<TickerFinancials>[]>;
  loadChart(request: ChartRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<PricePoint[]>>;
}

export function createShortWatchDependencies(
  marketData?: DataProvider,
  client: Pick<typeof apiClient, "getCloudShortInterest"> = apiClient,
): ShortWatchDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  const missing = () => Promise.reject(new Error("Market data coordinator unavailable"));
  return {
    loadRecords: async (symbol) => (await loadShortInterest(symbol, client)).records,
    loadSnapshots: (instruments, options) => coordinator ? coordinator.loadSnapshotsBatch(instruments, options) : missing(),
    loadChart: (request, options) => coordinator ? coordinator.loadChart(request, options) : missing(),
  };
}

/** A symbol's current float, the count it floats out of, and the statistics' short % of float with its settlement, from its snapshot. */
interface FloatSnapshot extends CurrentFloat {
  floatShares: number | null;
  floatAsOf: string | null;
  sharesOutstanding: number | null;
  statistics: SettlementFloatStatistics | null;
}

/** Each symbol's float and statistics, in order: empty where its snapshot is missing or carries none. */
async function loadFloats(
  symbols: readonly string[],
  loadSnapshots: ShortWatchDependencies["loadSnapshots"],
  options: { forceRefresh?: boolean } = {},
): Promise<FloatSnapshot[]> {
  const entries = await Promise.resolve()
    .then(() => loadSnapshots(symbols.map((symbol) => ({ symbol, exchange: "" })), options))
    .catch(() => []);
  return symbols.map((_symbol, index) => {
    const entry = entries[index];
    const fundamentals = (entry ? resolveEntryValue(entry) : null)?.fundamentals;
    return {
      floatShares: fundamentals?.floatShares ?? null,
      floatAsOf: fundamentals?.floatSharesAsOf ?? null,
      sharesOutstanding: fundamentals?.sharesOutstanding ?? null,
      statistics: fundamentals?.shortInterestDate
        ? { settlementDate: fundamentals.shortInterestDate, shortPercentOfFloat: fundamentals.shortPercentOfFloat ?? null }
        : null,
    };
  });
}

/**
 * A ticker's settlements, each with its percent of float (withPercentFloat):
 * the newest on the current float, as SIW reads it, the rest on the float of
 * their own day; with `pointInTime`, every one on its own day's. A snapshot
 * that fails leaves the settlements as they are.
 */
export async function loadShortInterestWithFloat(
  symbol: string,
  { marketData, client = apiClient, loadSnapshots = createShortWatchDependencies(marketData, client).loadSnapshots, pointInTime = false }: {
    marketData?: DataProvider;
    client?: Pick<typeof apiClient, "getCloudShortInterest">;
    loadSnapshots?: ShortWatchDependencies["loadSnapshots"];
    pointInTime?: boolean;
  } = {},
): Promise<ShortInterestResult> {
  const [result, [snapshot]] = await Promise.all([loadShortInterest(symbol, client), loadFloats([symbol], loadSnapshots)]);
  return { ...result, records: snapshot ? withPercentFloat(result.records, snapshot, { pointInTime }) : result.records };
}

/**
 * Every name's settlements, float and daily closes. The floats, with the
 * statistics' short % of float and its settlement, come in one batched
 * snapshot; settlements and closes are per symbol, six at a time. A name
 * whose closes fail keeps its short interest without a price move.
 */
export async function loadShortWatch(
  symbols: readonly string[],
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
  dependencies: ShortWatchDependencies = createShortWatchDependencies(),
): Promise<ShortWatchRow[]> {
  const instruments = symbols.map((symbol) => ({ symbol, exchange: "" }));
  const floats = loadFloats(symbols, dependencies.loadSnapshots, { forceRefresh: options.forceRefresh });
  const rows = new Array<ShortWatchRow>(symbols.length);
  let next = 0;
  const worker = async () => {
    while (next < instruments.length && !options.signal?.aborted) {
      const index = next++;
      const instrument = instruments[index]!;
      const [records, history] = await Promise.allSettled([
        dependencies.loadRecords(instrument.symbol),
        dependencies.loadChart({ instrument, bufferRange: "3M", granularity: "resolution", resolution: "1d" },
          { forceRefresh: options.forceRefresh }).then((entry) => resolveEntryValue(entry) ?? []),
      ]);
      const snapshot = (await floats)[index];
      rows[index] = buildShortWatchRow({
        symbol: instrument.symbol,
        records: records.status === "fulfilled" ? records.value : null,
        floatShares: snapshot?.floatShares ?? null,
        statistics: snapshot?.statistics ?? null,
        history: history.status === "fulfilled" ? history.value : null,
        error: records.status === "rejected" ? errorMessage(records.reason) : null,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, instruments.length) }, worker));
  options.signal?.throwIfAborted();
  return rows;
}
