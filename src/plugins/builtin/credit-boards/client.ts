import { apiClient } from "../../../api-client";
import type {
  CdxBoardPayload,
  CreditBoardPoint,
  SovrBoardPayload,
} from "../../../api-client/credit-boards";
import { createPluginCache } from "../../../data/plugin-cache";
import { createTtlCache } from "../../../data/ttl-cache";
import type { PricePoint } from "../../../types/financials";
import { logFailure } from "../../../utils/log-failure";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { currencyMoveFromHistory, currencyPair } from "./model";

/** New prints land every ten minutes; the server holds its board for five. */
const policy = { staleMs: 5 * 60_000, expireMs: 7 * 24 * 60 * 60_000 };
export const cdxBoardCache = createPluginCache<CdxBoardPayload>({
  kind: "cdx-board", source: "gloom-cloud", schemaVersion: 1, policy,
});
export const sovrBoardCache = createPluginCache<SovrBoardPayload>({
  kind: "sovr-board", source: "gloom-cloud", schemaVersion: 1, policy,
});

/** A year of daily levels: the chart and the 1Y rank. */
const BOARD_DAYS = 365;

const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value));
const optionalFinite = (value: unknown) => value === undefined || finiteOrNull(value);
const isInstant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const validPoints = (points: unknown) => Array.isArray(points) && points.every((point: CreditBoardPoint) =>
  point && isDate(point.date) && isDate(point.maturity) && Number.isFinite(point.level) && Number.isInteger(point.prints)
  && optionalFinite(point.spreadBp));

function validateCdxBoard(payload: CdxBoardPayload): CdxBoardPayload {
  if (!payload || !Array.isArray(payload.indexes) || payload.indexes.some((index) =>
    !index || typeof index.id !== "string" || typeof index.name !== "string"
    || (index.quote !== "spread" && index.quote !== "price")
    || !finiteOrNull(index.level) || !finiteOrNull(index.change1D) || !finiteOrNull(index.change1W)
    || (index.change1M !== undefined && !finiteOrNull(index.change1M))
    || !finiteOrNull(index.prints) || (index.date !== null && !isDate(index.date)) || !validPoints(index.points)
    || !optionalFinite(index.spreadBp) || (index.recovery !== undefined && !Number.isFinite(index.recovery))
    || (index.partial !== undefined && typeof index.partial !== "boolean")
    || (index.lastPrintAt != null && !isInstant(index.lastPrintAt))
    || (index.changeDate != null && !isDate(index.changeDate)))) {
    throw new Error("The server returned an invalid index CDS board");
  }
  return payload;
}

function validateSovrBoard(payload: SovrBoardPayload): SovrBoardPayload {
  if (!payload || !Array.isArray(payload.sovereigns) || payload.sovereigns.some((row) =>
    !row || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.currency !== "string"
    || !Number.isFinite(row.level) || !isDate(row.date) || !finiteOrNull(row.change1M) || !finiteOrNull(row.change1W)
    || !validPoints(row.points))) {
    throw new Error("The server returned an invalid sovereign CDS board");
  }
  return payload;
}

type BoardClient = Pick<typeof apiClient, "getCloudCdxBoard" | "getCloudSovrBoard">;

/** Days of history the server serves at most, for a history export. */
export const CDX_MAX_DAYS = 1100;

export async function fetchCdxBoard(client: BoardClient = apiClient, days = BOARD_DAYS): Promise<CdxBoardPayload> {
  try { return validateCdxBoard(await client.getCloudCdxBoard({ days })); }
  catch (error) { throw unavailableOnServer(error, "Index CDS levels are not available yet."); }
}

export async function fetchSovrBoard(client: BoardClient = apiClient): Promise<SovrBoardPayload> {
  try { return validateSovrBoard(await client.getCloudSovrBoard({ days: BOARD_DAYS })); }
  catch (error) { throw unavailableOnServer(error, "Sovereign CDS levels are not available yet."); }
}

export const getCachedCdxBoard = () => cachedCloudResource(cdxBoardCache, "5y", validateCdxBoard);
export const loadCdxBoard = (force = false) =>
  loadCloudResource(cdxBoardCache, "5y", () => fetchCdxBoard(), { force, validate: validateCdxBoard });
export const getCachedSovrBoard = () => cachedCloudResource(sovrBoardCache, "5y", validateSovrBoard);
export const loadSovrBoard = (force = false) =>
  loadCloudResource(sovrBoardCache, "5y", () => fetchSovrBoard(), { force, validate: validateSovrBoard });

export type PriceHistoryLoader = (symbol: string) => Promise<PricePoint[]>;

/** Closes a month back are yesterday's news for half an hour. */
const FX_HISTORY_TTL_MS = 30 * 60_000;
/** Twenty-odd currencies, a few at a time from a source that takes them one by one. */
const FX_HISTORY_CONCURRENCY = 4;
/** All at once from a source that batches them: the API client sends them sixteen a request. */
const FX_HISTORY_BATCHED_CONCURRENCY = 32;
const fxMoves = createTtlCache<number | null>({ ttlMs: FX_HISTORY_TTL_MS });

/** A load that fails reads as unknown for everyone waiting on it and is asked again next time, never remembered as unknown. */
function currencyMove(symbol: string, dollarsPerUnit: boolean, loadHistory: PriceHistoryLoader): Promise<number | null> {
  return fxMoves.load(symbol, async () => currencyMoveFromHistory(await loadHistory(symbol), dollarsPerUnit))
    .catch(logFailure("credit-boards", "Read a currency's price history failed", null));
}

/**
 * Each currency's 1M move against the dollar from its daily closes, shared
 * across panes. A currency with no pair or no history reads as unknown.
 * `batched`: `loadHistory` asks a source that batches them
 * (`DataProvider.batchesReads`) with `batch`, so they are all asked at once.
 */
export async function loadCurrencyMoves(
  currencies: readonly string[],
  loadHistory: PriceHistoryLoader,
  batched = false,
): Promise<Map<string, number | null>> {
  const queue = [...new Set(currencies)];
  const moves = new Map<string, number | null>();
  const worker = async () => {
    for (let currency = queue.shift(); currency; currency = queue.shift()) {
      const pair = currencyPair(currency);
      moves.set(currency, pair ? await currencyMove(pair.symbol, pair.dollarsPerUnit, loadHistory) : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(batched ? FX_HISTORY_BATCHED_CONCURRENCY : FX_HISTORY_CONCURRENCY, queue.length) }, worker));
  return moves;
}
