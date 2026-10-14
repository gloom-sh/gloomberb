import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, TickerFinancials } from "../../../types/financials";
import { errorMessage } from "../../../utils/errors";
import { loadShortInterest, type ShortInterestResult } from "./client";
import { withLatestPercentFloat } from "./model";
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

/** Each symbol's current float, in order: null where its snapshot is missing or carries none. */
async function loadFloatShares(
  symbols: readonly string[],
  loadSnapshots: ShortWatchDependencies["loadSnapshots"],
  options: { forceRefresh?: boolean } = {},
): Promise<Array<number | null>> {
  const entries = await Promise.resolve()
    .then(() => loadSnapshots(symbols.map((symbol) => ({ symbol, exchange: "" })), options))
    .catch(() => []);
  return symbols.map((_symbol, index) => {
    const entry = entries[index];
    return (entry ? resolveEntryValue(entry) : null)?.fundamentals?.floatShares ?? null;
  });
}

/**
 * A ticker's settlements with the newest one's percent of float, from the same
 * float SIW divides by. A snapshot that fails leaves the settlements as they are.
 */
export async function loadShortInterestWithFloat(
  symbol: string,
  { marketData, client = apiClient, loadSnapshots = createShortWatchDependencies(marketData, client).loadSnapshots }: {
    marketData?: DataProvider;
    client?: Pick<typeof apiClient, "getCloudShortInterest">;
    loadSnapshots?: ShortWatchDependencies["loadSnapshots"];
  } = {},
): Promise<ShortInterestResult> {
  const [result, [floatShares]] = await Promise.all([loadShortInterest(symbol, client), loadFloatShares([symbol], loadSnapshots)]);
  return { ...result, records: withLatestPercentFloat(result.records, floatShares) };
}

/**
 * Every name's settlements, float and daily closes. The floats come in one
 * batched snapshot; settlements and closes are per symbol, six at a time. A
 * name whose closes fail keeps its short interest without a price move.
 */
export async function loadShortWatch(
  symbols: readonly string[],
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
  dependencies: ShortWatchDependencies = createShortWatchDependencies(),
): Promise<ShortWatchRow[]> {
  const instruments = symbols.map((symbol) => ({ symbol, exchange: "" }));
  const floats = loadFloatShares(symbols, dependencies.loadSnapshots, { forceRefresh: options.forceRefresh });
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
      rows[index] = buildShortWatchRow({
        symbol: instrument.symbol,
        records: records.status === "fulfilled" ? records.value : null,
        floatShares: (await floats)[index] ?? null,
        history: history.status === "fulfilled" ? history.value : null,
        error: records.status === "rejected" ? errorMessage(records.reason) : null,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, instruments.length) }, worker));
  options.signal?.throwIfAborted();
  return rows;
}
