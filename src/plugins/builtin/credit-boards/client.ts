import { apiClient } from "../../../api-client";
import type {
  CdxBoardPayload,
  CreditBoardPoint,
  SovrBoardPayload,
} from "../../../api-client/credit-boards";
import { createPluginCache } from "../../../data/plugin-cache";
import type { PricePoint } from "../../../types/financials";
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
const validPoints = (points: unknown) => Array.isArray(points) && points.every((point: CreditBoardPoint) =>
  point && isDate(point.date) && isDate(point.maturity) && Number.isFinite(point.level) && Number.isInteger(point.prints));

function validateCdxBoard(payload: CdxBoardPayload): CdxBoardPayload {
  if (!payload || !Array.isArray(payload.indexes) || payload.indexes.some((index) =>
    !index || typeof index.id !== "string" || typeof index.name !== "string"
    || (index.quote !== "spread" && index.quote !== "price")
    || !finiteOrNull(index.level) || !finiteOrNull(index.change1D) || !finiteOrNull(index.change1W)
    || !finiteOrNull(index.prints) || (index.date !== null && !isDate(index.date)) || !validPoints(index.points))) {
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

export async function fetchCdxBoard(client: BoardClient = apiClient): Promise<CdxBoardPayload> {
  try { return validateCdxBoard(await client.getCloudCdxBoard({ days: BOARD_DAYS })); }
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
/** Twenty-odd currencies at once; a few requests at a time keep the feed from refusing them. */
const FX_HISTORY_CONCURRENCY = 4;
const fxMoves = new Map<string, { at: number; move: Promise<number | null> }>();

function currencyMove(symbol: string, dollarsPerUnit: boolean, loadHistory: PriceHistoryLoader): Promise<number | null> {
  const cached = fxMoves.get(symbol);
  if (cached && Date.now() - cached.at <= FX_HISTORY_TTL_MS) return cached.move;
  const move = loadHistory(symbol).then((history) => currencyMoveFromHistory(history, dollarsPerUnit));
  fxMoves.set(symbol, { at: Date.now(), move });
  // A failed load is retried next time rather than remembered as unknown.
  return move.catch(() => {
    fxMoves.delete(symbol);
    return null;
  });
}

/**
 * Each currency's 1M move against the dollar from its daily closes, shared
 * across panes. A currency with no pair or no history reads as unknown.
 */
export async function loadCurrencyMoves(
  currencies: readonly string[],
  loadHistory: PriceHistoryLoader,
): Promise<Map<string, number | null>> {
  const queue = [...new Set(currencies)];
  const moves = new Map<string, number | null>();
  const worker = async () => {
    for (let currency = queue.shift(); currency; currency = queue.shift()) {
      const pair = currencyPair(currency);
      moves.set(currency, pair ? await currencyMove(pair.symbol, pair.dollarsPerUnit, loadHistory) : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FX_HISTORY_CONCURRENCY, queue.length) }, worker));
  return moves;
}
