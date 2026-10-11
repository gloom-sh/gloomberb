import { apiClient } from "../../../api-client";
import type { EuropePowerBoard, EuropePowerHistory, PowerPriceRow } from "../../../api-client/europe-energy";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

/** What the tab and the series say while the server has no prices to serve: before the backend ships, or before its first read. */
export const POWER_PRICES_NOT_AVAILABLE = "European power prices are not available yet.";

// Daily data, rewritten once a day: a quarter hour is soon enough to catch it.
const policy = { staleMs: 15 * 60_000, expireMs: 14 * 86_400_000 };
export const powerPricesCache = createPluginCache<EuropePowerBoard>({ kind: "europe-power-board", source: "gloom-cloud", schemaVersion: 1, policy });
export const powerPriceHistoryCache = createPluginCache<EuropePowerHistory>({ kind: "europe-power-history", source: "gloom-cloud", schemaVersion: 1, policy });

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const date = (v: unknown) => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const dateOrNull = (v: unknown) => v === null || date(v);
const finiteOrNull = (v: unknown) => v === null || finite(v);
const instantOrNull = (v: unknown) => v === null || text(v) && Number.isFinite(Date.parse(v));
const source = (v: unknown) => record(v) && text(v.name) && text(v.licence) && text(v.url);
const points = (v: unknown) => Array.isArray(v) && v.every((p) => record(p) && date(p.date) && finite(p.value));

function validRow(row: PowerPriceRow): boolean {
  return record(row) && /^[A-Z]{2}$/.test(row.code) && text(row.name) && dateOrNull(row.date) && finiteOrNull(row.price)
    && (row.price == null) === (row.date == null) && dateOrNull(row.previousDate) && dateOrNull(row.yearAgoDate)
    && [row.change, row.average7, row.average30, row.yearAgo, row.low52w, row.high52w].every(finiteOrNull) && points(row.trail);
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
export function validatePowerPrices(data: EuropePowerBoard): EuropePowerBoard {
  if (!record(data) || !text(data.generatedAt) || !instantOrNull(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || data.market !== "day-ahead" || data.unit !== "EUR/MWh" || !source(data.source)
    || !instantOrNull(data.checkedAt) || !instantOrNull(data.publishedAt)
    || !Array.isArray(data.gaps) || !data.gaps.every(text)
    || !Array.isArray(data.rows) || !data.rows.every(validRow) || new Set(data.rows.map((row) => row.code)).size !== data.rows.length) {
    throw new Error("The server returned unreadable power prices.");
  }
  return data;
}

function validateHistory(data: EuropePowerHistory): EuropePowerHistory {
  if (!record(data) || !/^[A-Z]{2}$/.test(data.code) || !text(data.name) || data.unit !== "EUR/MWh" || !source(data.source) || !points(data.points)) {
    throw new Error("The server returned unreadable power price history.");
  }
  return data;
}

type PricesApi = Pick<typeof apiClient, "getCloudEuropePower" | "getCloudEuropePowerHistory">;

/**
 * The board, or the not-available message when the server does not serve the
 * route yet (404), cannot read its tables (503) or has no days stored.
 */
export async function fetchPowerPrices(client: Pick<PricesApi, "getCloudEuropePower"> = apiClient): Promise<EuropePowerBoard> {
  let board: EuropePowerBoard;
  try {
    board = validatePowerPrices(await client.getCloudEuropePower());
  } catch (error) {
    throw unavailableOnServer(error, POWER_PRICES_NOT_AVAILABLE, [404, 503]);
  }
  if (board.status === "unavailable") throw new Error(POWER_PRICES_NOT_AVAILABLE);
  return board;
}

/** One market's days from `from`, all of them without one. */
export async function fetchPowerPriceHistory(
  code: string, from?: string | null, client: Pick<PricesApi, "getCloudEuropePowerHistory"> = apiClient,
): Promise<EuropePowerHistory> {
  try {
    return validateHistory(await client.getCloudEuropePowerHistory(code, from));
  } catch (error) {
    throw unavailableOnServer(error, POWER_PRICES_NOT_AVAILABLE, [404, 503]);
  }
}

export const getCachedPowerPrices = () => cachedCloudResource(powerPricesCache, "board", validatePowerPrices);
export const loadPowerPrices = (force = false) =>
  loadCloudResource(powerPricesCache, "board", () => fetchPowerPrices(), { force, validate: validatePowerPrices });
/** The whole history of one market, cached per market. */
export const loadPowerPriceHistory = (code: string, force = false) =>
  loadCloudResource(powerPriceHistoryCache, code, () => fetchPowerPriceHistory(code), { force, validate: validateHistory });
