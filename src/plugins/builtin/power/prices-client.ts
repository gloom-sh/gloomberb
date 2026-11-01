import { apiClient } from "../../../api-client";
import { sourceDidNotAnswer } from "../../../api-client/errors";
import type { CarbonBoard, CarbonHistory, EuropePowerBoard, EuropePowerHistory, PowerPriceRow } from "../../../api-client/europe-energy";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

/** What the tab and the series say while the server has no prices to serve: before the backend ships, or before its first read. */
export const POWER_PRICES_NOT_AVAILABLE = "European power prices are not available yet.";
const CARBON_PRICE_NOT_AVAILABLE = "The EU carbon auction price is not available yet.";

// Daily data, rewritten once a day: a quarter hour is soon enough to catch it.
const policy = { staleMs: 15 * 60_000, expireMs: 14 * 86_400_000 };
export const powerPricesCache = createPluginCache<EuropePowerBoard>({ kind: "europe-power-board", source: "gloom-cloud", schemaVersion: 1, policy });
export const powerPriceHistoryCache = createPluginCache<EuropePowerHistory>({ kind: "europe-power-history", source: "gloom-cloud", schemaVersion: 1, policy });
export const carbonPriceCache = createPluginCache<CarbonBoard>({ kind: "europe-carbon-board", source: "gloom-cloud", schemaVersion: 1, policy });
export const carbonHistoryCache = createPluginCache<CarbonHistory>({ kind: "europe-carbon-history", source: "gloom-cloud", schemaVersion: 1, policy });

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const date = (v: unknown) => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const dateOrNull = (v: unknown) => v === null || date(v);
const finiteOrNull = (v: unknown) => v === null || finite(v);
const instantOrNull = (v: unknown) => v === null || text(v) && Number.isFinite(Date.parse(v));
const source = (v: unknown) => record(v) && text(v.name) && text(v.licence) && text(v.url);
const publisher = (v: unknown) => record(v) && text(v.name) && text(v.url);
const nullableText = (v: unknown) => v === null || text(v);
const nonnegativeOrNull = (v: unknown) => v === null || finite(v) && v >= 0;
const points = (v: unknown) => Array.isArray(v) && v.every((p) => record(p) && date(p.date) && finite(p.value));

function validRow(row: PowerPriceRow, code = /^[A-Z]{2}$/): boolean {
  return record(row) && code.test(row.code) && text(row.name) && dateOrNull(row.date) && finiteOrNull(row.price)
    && (row.price == null) === (row.date == null) && dateOrNull(row.previousDate) && dateOrNull(row.yearAgoDate)
    && [row.change, row.average7, row.average30, row.yearAgo, row.low52w, row.high52w].every(finiteOrNull) && points(row.trail);
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
export function validatePowerPrices(data: EuropePowerBoard): EuropePowerBoard {
  if (!record(data) || !text(data.generatedAt) || !instantOrNull(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || data.market !== "day-ahead" || data.unit !== "EUR/MWh" || !source(data.source)
    || !instantOrNull(data.checkedAt) || !instantOrNull(data.publishedAt)
    || !Array.isArray(data.gaps) || !data.gaps.every(text)
    || !Array.isArray(data.rows) || !data.rows.every((row) => validRow(row)) || new Set(data.rows.map((row) => row.code)).size !== data.rows.length) {
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

/** An EUA board that breaks the contract is refused whole. */
export function validateCarbonPrice(data: CarbonBoard): CarbonBoard {
  const row = data?.row;
  if (!record(data) || !text(data.generatedAt) || !instantOrNull(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || data.market !== "primary auction" || data.unit !== "EUR/tCO2" || !publisher(data.source)
    || !instantOrNull(data.checkedAt) || !instantOrNull(data.publishedAt) || !Array.isArray(data.gaps) || !data.gaps.every(text)
    || !record(row) || !validRow(row, /^EUA$/) || !nonnegativeOrNull(row.volume) || !nonnegativeOrNull(row.auctions)
    || !Array.isArray(data.auctions) || !data.auctions.every((a) => record(a) && date(a.date) && text(a.auction) && text(a.contract) && text(a.status)
      && nullableText(a.zone) && [a.price, a.minBid, a.maxBid, a.meanBid, a.medianBid].every(finiteOrNull) && finite(a.volume)
      && [a.coverRatio, a.bidders, a.successfulBidders].every(nonnegativeOrNull) && typeof a.aviation === "boolean")) {
    throw new Error("The server returned an unreadable EU carbon price.");
  }
  return data;
}

function validateCarbonHistory(data: CarbonHistory): CarbonHistory {
  if (!record(data) || data.code !== "EUA" || data.unit !== "EUR/tCO2" || !publisher(data.source) || !points(data.points)) {
    throw new Error("The server returned an unreadable EU carbon price history.");
  }
  return data;
}

type PricesApi = Pick<typeof apiClient, "getCloudEuropePower" | "getCloudEuropePowerHistory" | "getCloudEuropeCarbon" | "getCloudEuropeCarbonHistory">;

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
  if (board.status === "unavailable") throw sourceDidNotAnswer(POWER_PRICES_NOT_AVAILABLE);
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

/** The EUA board, or the not-available message before the server serves it or has an auction stored. */
export async function fetchCarbonPrice(client: Pick<PricesApi, "getCloudEuropeCarbon"> = apiClient): Promise<CarbonBoard> {
  let board: CarbonBoard;
  try {
    board = validateCarbonPrice(await client.getCloudEuropeCarbon());
  } catch (error) {
    throw unavailableOnServer(error, CARBON_PRICE_NOT_AVAILABLE, [404, 503]);
  }
  if (board.status === "unavailable") throw sourceDidNotAnswer(CARBON_PRICE_NOT_AVAILABLE);
  return board;
}

/** The daily EUA price from `from`, every auction day since 2020 without one. */
export async function fetchCarbonHistory(
  from?: string | null, client: Pick<PricesApi, "getCloudEuropeCarbonHistory"> = apiClient,
): Promise<CarbonHistory> {
  try {
    return validateCarbonHistory(await client.getCloudEuropeCarbonHistory(from));
  } catch (error) {
    throw unavailableOnServer(error, CARBON_PRICE_NOT_AVAILABLE, [404, 503]);
  }
}

export const getCachedPowerPrices = () => cachedCloudResource(powerPricesCache, "board", validatePowerPrices);
export const loadPowerPrices = (force = false) =>
  loadCloudResource(powerPricesCache, "board", () => fetchPowerPrices(), { force, validate: validatePowerPrices });
export const getCachedCarbonPrice = () => cachedCloudResource(carbonPriceCache, "board", validateCarbonPrice);
export const loadCarbonPrice = (force = false) =>
  loadCloudResource(carbonPriceCache, "board", () => fetchCarbonPrice(), { force, validate: validateCarbonPrice });
/** Every auction day of the EUA since 2020. */
export const loadCarbonHistory = (force = false) =>
  loadCloudResource(carbonHistoryCache, "EUA", () => fetchCarbonHistory(), { force, validate: validateCarbonHistory });
/** The whole history of one market, cached per market. */
export const loadPowerPriceHistory = (code: string, force = false) =>
  loadCloudResource(powerPriceHistoryCache, code, () => fetchPowerPriceHistory(code), { force, validate: validateHistory });
