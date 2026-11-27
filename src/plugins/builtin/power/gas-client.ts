import { apiClient } from "../../../api-client";
import type { GasStorageBoard, GasStorageHistory, GasStorageRow, GasStorageSeasonal } from "../../../api-client/europe-energy";
import { isCalendarDay, isFiniteNumber, isIsoInstant, isNullableCalendarDay, isNullableFinite, isNullableIsoInstant, isRecord, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

/** What the board and the series say while the server has no storage figures: before the backend ships, or before its first read. */
export const GAS_STORAGE_NOT_AVAILABLE = "European gas storage is not available yet.";

// Published once a day in the evening and revised later: a quarter hour is soon enough.
const policy = { staleMs: 15 * 60_000, expireMs: 14 * 86_400_000 };
const text = (v: unknown): v is string => typeof v === "string";
const status = (v: unknown) => v === "estimated" || v === "confirmed";
const publisher = (v: unknown) => isRecord(v) && text(v.name) && text(v.url);
const units = (v: unknown) => isRecord(v) && v.full === "%" && v.storage === "TWh" && v.flow === "GWh/day";
const AREA = /^[A-Z]{2}$/;

function validRow(row: GasStorageRow): boolean {
  const ago = row?.yearAgo, five = row?.fiveYear;
  return isRecord(row) && AREA.test(row.code) && text(row.name) && isNullableCalendarDay(row.gasDay)
    && (row.gasDay == null ? row.status === null && row.full === null : status(row.status) && isFiniteNumber(row.full))
    && [row.gasInStorage, row.workingGasVolume, row.injection, row.withdrawal, row.change].every(isNullableFinite)
    && isNullableCalendarDay(row.previousGasDay)
    && (ago === null || isRecord(ago) && isCalendarDay(ago.gasDay) && isFiniteNumber(ago.full) && isNullableFinite(ago.gasInStorage) && isFiniteNumber(ago.change))
    && (five === null || isRecord(five) && Array.isArray(five.years) && five.years.length > 0 && five.years.every(Number.isInteger)
      && [five.min, five.max, five.average, five.vsAverage].every(isFiniteNumber) && isNullableFinite(five.position))
    && Array.isArray(row.trail) && row.trail.every((p) => isRecord(p) && isCalendarDay(p.date) && isFiniteNumber(p.value));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
export function validateGasStorage(data: GasStorageBoard): GasStorageBoard {
  if (!isRecord(data) || !isIsoInstant(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || !units(data.units) || !publisher(data.source) || !isNullableIsoInstant(data.checkedAt) || !isStringArray(data.gaps)
    || !Array.isArray(data.rows) || !data.rows.every(validRow) || new Set(data.rows.map((row) => row.code)).size !== data.rows.length) {
    throw new Error("The server returned unreadable gas storage figures.");
  }
  return data;
}

function validateGasHistory(data: GasStorageHistory): GasStorageHistory {
  if (!isRecord(data) || !AREA.test(data.code) || !text(data.name) || !units(data.units) || !publisher(data.source) || !Array.isArray(data.points)
    || !data.points.every((p) => isRecord(p) && isCalendarDay(p.date) && status(p.status)
      && [p.full, p.gasInStorage, p.workingGasVolume, p.injection, p.withdrawal].every(isNullableFinite))) {
    throw new Error("The server returned an unreadable gas storage history.");
  }
  return data;
}

const pairs = (v: unknown) => Array.isArray(v) && v.every((p) => Array.isArray(p) && isCalendarDay(p[0]) && isFiniteNumber(p[1]));

export function validateGasSeasonal(data: GasStorageSeasonal): GasStorageSeasonal {
  if (!isRecord(data) || !AREA.test(data.code) || !text(data.name) || data.unit !== "%" || !publisher(data.source)
    || !(data.year === null || Number.isInteger(data.year)) || !Array.isArray(data.years) || !data.years.every(Number.isInteger)
    || !pairs(data.current) || !pairs(data.previous) || !Array.isArray(data.band)
    || !data.band.every((day) => Array.isArray(day) && isCalendarDay(day[0]) && day.slice(1, 4).every(isNullableFinite) && Number.isInteger(day[4]))) {
    throw new Error("The server returned an unreadable gas storage range.");
  }
  return data;
}

type GasApi = Pick<typeof apiClient, "getCloudEuropeGas" | "getCloudEuropeGasHistory" | "getCloudEuropeGasSeasonal">;
const unavailable = { unavailableMessage: GAS_STORAGE_NOT_AVAILABLE, unavailableStatuses: [404, 503] as const };

const gasStorageEndpoint = createCloudEndpoint<void, GasStorageBoard, Pick<GasApi, "getCloudEuropeGas">>({
  kind: "europe-gas-board", schemaVersion: 1, policy, key: "board", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudEuropeGas(), validate: validateGasStorage,
  isEmptyAnswer: (board) => board.status === "unavailable", ...unavailable,
});
const gasHistoryEndpoint = createCloudEndpoint<{ code: string; from?: string | null }, GasStorageHistory, Pick<GasApi, "getCloudEuropeGasHistory">>({
  kind: "europe-gas-history", schemaVersion: 1, policy, key: ({ code }) => code, defaultClient: apiClient,
  fetch: ({ code, from }, client) => client.getCloudEuropeGasHistory(code, from), validate: validateGasHistory, ...unavailable,
});
const gasSeasonalEndpoint = createCloudEndpoint<string, GasStorageSeasonal, Pick<GasApi, "getCloudEuropeGasSeasonal">>({
  kind: "europe-gas-seasonal", schemaVersion: 1, policy, key: (code) => code, defaultClient: apiClient,
  fetch: (code, client) => client.getCloudEuropeGasSeasonal(code), validate: validateGasSeasonal, ...unavailable,
});

export const gasStorageCache = gasStorageEndpoint.cache;
export const gasHistoryCache = gasHistoryEndpoint.cache;
export const gasSeasonalCache = gasSeasonalEndpoint.cache;

/** The board, or the not-available message before the server serves it (404), can read its tables (503) or has a day stored. */
export const fetchGasStorage = (client: Pick<GasApi, "getCloudEuropeGas"> = apiClient) => gasStorageEndpoint.fetch(undefined, { client });
/** One area's gas days from `from`, every day kept without one. */
export const fetchGasHistory = (code: string, from?: string | null, client: Pick<GasApi, "getCloudEuropeGasHistory"> = apiClient) =>
  gasHistoryEndpoint.fetch({ code, from }, { client });
export const fetchGasSeasonal = (code: string, client: Pick<GasApi, "getCloudEuropeGasSeasonal"> = apiClient) =>
  gasSeasonalEndpoint.fetch(code, { client });

export const getCachedGasStorage = () => gasStorageEndpoint.cached();
export const loadGasStorage = (force = false) => gasStorageEndpoint.load(undefined, { force });
/** Every kept gas day of one area, cached per area. */
export const loadGasHistory = (code: string, force = false) => gasHistoryEndpoint.load({ code }, { force });
export const loadGasSeasonal = (code: string, force = false) => gasSeasonalEndpoint.load(code, { force });
