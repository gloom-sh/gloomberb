import { apiClient } from "../../../api-client";
import { sourceDidNotAnswer } from "../../../api-client/errors";
import type { GasStorageBoard, GasStorageHistory, GasStorageRow, GasStorageSeasonal } from "../../../api-client/europe-energy";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

/** What the board and the series say while the server has no storage figures: before the backend ships, or before its first read. */
export const GAS_STORAGE_NOT_AVAILABLE = "European gas storage is not available yet.";

// Published once a day in the evening and revised later: a quarter hour is soon enough.
const policy = { staleMs: 15 * 60_000, expireMs: 14 * 86_400_000 };
export const gasStorageCache = createPluginCache<GasStorageBoard>({ kind: "europe-gas-board", source: "gloom-cloud", schemaVersion: 1, policy });
export const gasHistoryCache = createPluginCache<GasStorageHistory>({ kind: "europe-gas-history", source: "gloom-cloud", schemaVersion: 1, policy });
export const gasSeasonalCache = createPluginCache<GasStorageSeasonal>({ kind: "europe-gas-seasonal", source: "gloom-cloud", schemaVersion: 1, policy });

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const date = (v: unknown): v is string => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const dateOrNull = (v: unknown) => v === null || date(v);
const finiteOrNull = (v: unknown) => v === null || finite(v);
const instantOrNull = (v: unknown) => v === null || text(v) && Number.isFinite(Date.parse(v));
const status = (v: unknown) => v === "estimated" || v === "confirmed";
const publisher = (v: unknown) => record(v) && text(v.name) && text(v.url);
const units = (v: unknown) => record(v) && v.full === "%" && v.storage === "TWh" && v.flow === "GWh/day";
const AREA = /^[A-Z]{2}$/;

function validRow(row: GasStorageRow): boolean {
  const ago = row?.yearAgo, five = row?.fiveYear;
  return record(row) && AREA.test(row.code) && text(row.name) && dateOrNull(row.gasDay)
    && (row.gasDay == null ? row.status === null && row.full === null : status(row.status) && finite(row.full))
    && [row.gasInStorage, row.workingGasVolume, row.injection, row.withdrawal, row.change].every(finiteOrNull)
    && dateOrNull(row.previousGasDay)
    && (ago === null || record(ago) && date(ago.gasDay) && finite(ago.full) && finiteOrNull(ago.gasInStorage) && finite(ago.change))
    && (five === null || record(five) && Array.isArray(five.years) && five.years.length > 0 && five.years.every(Number.isInteger)
      && [five.min, five.max, five.average, five.vsAverage].every(finite) && finiteOrNull(five.position))
    && Array.isArray(row.trail) && row.trail.every((p) => record(p) && date(p.date) && finite(p.value));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
export function validateGasStorage(data: GasStorageBoard): GasStorageBoard {
  if (!record(data) || !text(data.generatedAt) || !instantOrNull(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || !units(data.units) || !publisher(data.source) || !instantOrNull(data.checkedAt) || !Array.isArray(data.gaps) || !data.gaps.every(text)
    || !Array.isArray(data.rows) || !data.rows.every(validRow) || new Set(data.rows.map((row) => row.code)).size !== data.rows.length) {
    throw new Error("The server returned unreadable gas storage figures.");
  }
  return data;
}

function validateGasHistory(data: GasStorageHistory): GasStorageHistory {
  if (!record(data) || !AREA.test(data.code) || !text(data.name) || !units(data.units) || !publisher(data.source) || !Array.isArray(data.points)
    || !data.points.every((p) => record(p) && date(p.date) && status(p.status)
      && [p.full, p.gasInStorage, p.workingGasVolume, p.injection, p.withdrawal].every(finiteOrNull))) {
    throw new Error("The server returned an unreadable gas storage history.");
  }
  return data;
}

const pairs = (v: unknown) => Array.isArray(v) && v.every((p) => Array.isArray(p) && date(p[0]) && finite(p[1]));

export function validateGasSeasonal(data: GasStorageSeasonal): GasStorageSeasonal {
  if (!record(data) || !AREA.test(data.code) || !text(data.name) || data.unit !== "%" || !publisher(data.source)
    || !(data.year === null || Number.isInteger(data.year)) || !Array.isArray(data.years) || !data.years.every(Number.isInteger)
    || !pairs(data.current) || !pairs(data.previous) || !Array.isArray(data.band)
    || !data.band.every((day) => Array.isArray(day) && date(day[0]) && day.slice(1, 4).every(finiteOrNull) && Number.isInteger(day[4]))) {
    throw new Error("The server returned an unreadable gas storage range.");
  }
  return data;
}

type GasApi = Pick<typeof apiClient, "getCloudEuropeGas" | "getCloudEuropeGasHistory" | "getCloudEuropeGasSeasonal">;

/** The board, or the not-available message before the server serves it (404), can read its tables (503) or has a day stored. */
export async function fetchGasStorage(client: Pick<GasApi, "getCloudEuropeGas"> = apiClient): Promise<GasStorageBoard> {
  let board: GasStorageBoard;
  try {
    board = validateGasStorage(await client.getCloudEuropeGas());
  } catch (error) {
    throw unavailableOnServer(error, GAS_STORAGE_NOT_AVAILABLE, [404, 503]);
  }
  if (board.status === "unavailable") throw sourceDidNotAnswer(GAS_STORAGE_NOT_AVAILABLE);
  return board;
}

/** One area's gas days from `from`, every day kept without one. */
export async function fetchGasHistory(
  code: string, from?: string | null, client: Pick<GasApi, "getCloudEuropeGasHistory"> = apiClient,
): Promise<GasStorageHistory> {
  try {
    return validateGasHistory(await client.getCloudEuropeGasHistory(code, from));
  } catch (error) {
    throw unavailableOnServer(error, GAS_STORAGE_NOT_AVAILABLE, [404, 503]);
  }
}

export async function fetchGasSeasonal(code: string, client: Pick<GasApi, "getCloudEuropeGasSeasonal"> = apiClient): Promise<GasStorageSeasonal> {
  try {
    return validateGasSeasonal(await client.getCloudEuropeGasSeasonal(code));
  } catch (error) {
    throw unavailableOnServer(error, GAS_STORAGE_NOT_AVAILABLE, [404, 503]);
  }
}

export const getCachedGasStorage = () => cachedCloudResource(gasStorageCache, "board", validateGasStorage);
export const loadGasStorage = (force = false) =>
  loadCloudResource(gasStorageCache, "board", () => fetchGasStorage(), { force, validate: validateGasStorage });
/** Every kept gas day of one area, cached per area. */
export const loadGasHistory = (code: string, force = false) =>
  loadCloudResource(gasHistoryCache, code, () => fetchGasHistory(code), { force, validate: validateGasHistory });
export const loadGasSeasonal = (code: string, force = false) =>
  loadCloudResource(gasSeasonalCache, code, () => fetchGasSeasonal(code), { force, validate: validateGasSeasonal });
