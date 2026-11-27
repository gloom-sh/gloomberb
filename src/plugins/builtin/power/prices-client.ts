import { apiClient } from "../../../api-client";
import type { CarbonBoard, CarbonHistory, EuropePowerBoard, EuropePowerHistory, PowerPriceRow } from "../../../api-client/europe-energy";
import { isCalendarDay, isFiniteNumber, isIsoInstant, isNonNegative, isNullableCalendarDay, isNullableFinite, isNullableIsoInstant, isNullableString, isRecord, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

/** What the tab and the series say while the server has no prices to serve: before the backend ships, or before its first read. */
export const POWER_PRICES_NOT_AVAILABLE = "European power prices are not available yet.";
const CARBON_PRICE_NOT_AVAILABLE = "The EU carbon auction price is not available yet.";

// Daily data, rewritten once a day: a quarter hour is soon enough to catch it.
const policy = { staleMs: 15 * 60_000, expireMs: 14 * 86_400_000 };
const text = (v: unknown): v is string => typeof v === "string";
const source = (v: unknown) => isRecord(v) && text(v.name) && text(v.licence) && text(v.url);
const publisher = (v: unknown) => isRecord(v) && text(v.name) && text(v.url);
const nonnegativeOrNull = (v: unknown) => v === null || isNonNegative(v);
const points = (v: unknown) => Array.isArray(v) && v.every((p) => isRecord(p) && isCalendarDay(p.date) && isFiniteNumber(p.value));

function validRow(row: PowerPriceRow, code = /^[A-Z]{2}$/): boolean {
  return isRecord(row) && code.test(row.code) && text(row.name) && isNullableCalendarDay(row.date) && isNullableFinite(row.price)
    && (row.price == null) === (row.date == null) && isNullableCalendarDay(row.previousDate) && isNullableCalendarDay(row.yearAgoDate)
    && [row.change, row.average7, row.average30, row.yearAgo, row.low52w, row.high52w].every(isNullableFinite) && points(row.trail);
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
export function validatePowerPrices(data: EuropePowerBoard): EuropePowerBoard {
  if (!isRecord(data) || !isIsoInstant(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || data.market !== "day-ahead" || data.unit !== "EUR/MWh" || !source(data.source)
    || !isNullableIsoInstant(data.checkedAt) || !isNullableIsoInstant(data.publishedAt) || !isStringArray(data.gaps)
    || !Array.isArray(data.rows) || !data.rows.every((row) => validRow(row)) || new Set(data.rows.map((row) => row.code)).size !== data.rows.length) {
    throw new Error("The server returned unreadable power prices.");
  }
  return data;
}

function validateHistory(data: EuropePowerHistory): EuropePowerHistory {
  if (!isRecord(data) || !/^[A-Z]{2}$/.test(data.code) || !text(data.name) || data.unit !== "EUR/MWh" || !source(data.source) || !points(data.points)) {
    throw new Error("The server returned unreadable power price history.");
  }
  return data;
}

/** An EUA board that breaks the contract is refused whole. */
export function validateCarbonPrice(data: CarbonBoard): CarbonBoard {
  const row = data?.row;
  if (!isRecord(data) || !isIsoInstant(data.generatedAt) || !["available", "unavailable"].includes(data.status)
    || data.market !== "primary auction" || data.unit !== "EUR/tCO2" || !publisher(data.source)
    || !isNullableIsoInstant(data.checkedAt) || !isNullableIsoInstant(data.publishedAt) || !isStringArray(data.gaps)
    || !isRecord(row) || !validRow(row, /^EUA$/) || !nonnegativeOrNull(row.volume) || !nonnegativeOrNull(row.auctions)
    || !Array.isArray(data.auctions) || !data.auctions.every((a) => isRecord(a) && isCalendarDay(a.date) && text(a.auction) && text(a.contract) && text(a.status)
      && isNullableString(a.zone) && [a.price, a.minBid, a.maxBid, a.meanBid, a.medianBid].every(isNullableFinite) && isFiniteNumber(a.volume)
      && [a.coverRatio, a.bidders, a.successfulBidders].every(nonnegativeOrNull) && typeof a.aviation === "boolean")) {
    throw new Error("The server returned an unreadable EU carbon price.");
  }
  return data;
}

function validateCarbonHistory(data: CarbonHistory): CarbonHistory {
  if (!isRecord(data) || data.code !== "EUA" || data.unit !== "EUR/tCO2" || !publisher(data.source) || !points(data.points)) {
    throw new Error("The server returned an unreadable EU carbon price history.");
  }
  return data;
}

type PricesApi = Pick<typeof apiClient, "getCloudEuropePower" | "getCloudEuropePowerHistory" | "getCloudEuropeCarbon" | "getCloudEuropeCarbonHistory">;
const powerUnavailable = { unavailableMessage: POWER_PRICES_NOT_AVAILABLE, unavailableStatuses: [404, 503] as const };
const carbonUnavailable = { unavailableMessage: CARBON_PRICE_NOT_AVAILABLE, unavailableStatuses: [404, 503] as const };

const powerPricesEndpoint = createCloudEndpoint<void, EuropePowerBoard, Pick<PricesApi, "getCloudEuropePower">>({
  kind: "europe-power-board", schemaVersion: 1, policy, key: "board", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudEuropePower(), validate: validatePowerPrices,
  isEmptyAnswer: (board) => board.status === "unavailable", ...powerUnavailable,
});
const powerPriceHistoryEndpoint = createCloudEndpoint<{ code: string; from?: string | null }, EuropePowerHistory, Pick<PricesApi, "getCloudEuropePowerHistory">>({
  kind: "europe-power-history", schemaVersion: 1, policy, key: ({ code }) => code, defaultClient: apiClient,
  fetch: ({ code, from }, client) => client.getCloudEuropePowerHistory(code, from), validate: validateHistory, ...powerUnavailable,
});
const carbonPriceEndpoint = createCloudEndpoint<void, CarbonBoard, Pick<PricesApi, "getCloudEuropeCarbon">>({
  kind: "europe-carbon-board", schemaVersion: 1, policy, key: "board", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudEuropeCarbon(), validate: validateCarbonPrice,
  isEmptyAnswer: (board) => board.status === "unavailable", ...carbonUnavailable,
});
const carbonHistoryEndpoint = createCloudEndpoint<string | null | undefined, CarbonHistory, Pick<PricesApi, "getCloudEuropeCarbonHistory">>({
  kind: "europe-carbon-history", schemaVersion: 1, policy, key: "EUA", defaultClient: apiClient,
  fetch: (from, client) => client.getCloudEuropeCarbonHistory(from), validate: validateCarbonHistory, ...carbonUnavailable,
});

export const powerPricesCache = powerPricesEndpoint.cache;
export const powerPriceHistoryCache = powerPriceHistoryEndpoint.cache;
export const carbonPriceCache = carbonPriceEndpoint.cache;
export const carbonHistoryCache = carbonHistoryEndpoint.cache;

/** The board, or the not-available message when the server does not serve the route yet (404), cannot read its tables (503) or has no days stored. */
export const fetchPowerPrices = (client: Pick<PricesApi, "getCloudEuropePower"> = apiClient) => powerPricesEndpoint.fetch(undefined, { client });
/** One market's days from `from`, all of them without one. */
export const fetchPowerPriceHistory = (code: string, from?: string | null, client: Pick<PricesApi, "getCloudEuropePowerHistory"> = apiClient) =>
  powerPriceHistoryEndpoint.fetch({ code, from }, { client });
/** The EUA board, or the not-available message before the server serves it or has an auction stored. */
export const fetchCarbonPrice = (client: Pick<PricesApi, "getCloudEuropeCarbon"> = apiClient) => carbonPriceEndpoint.fetch(undefined, { client });
/** The daily EUA price from `from`, every auction day since 2020 without one. */
export const fetchCarbonHistory = (from?: string | null, client: Pick<PricesApi, "getCloudEuropeCarbonHistory"> = apiClient) =>
  carbonHistoryEndpoint.fetch(from, { client });

export const getCachedPowerPrices = () => powerPricesEndpoint.cached();
export const loadPowerPrices = (force = false) => powerPricesEndpoint.load(undefined, { force });
export const getCachedCarbonPrice = () => carbonPriceEndpoint.cached();
export const loadCarbonPrice = (force = false) => carbonPriceEndpoint.load(undefined, { force });
/** Every auction day of the EUA since 2020. */
export const loadCarbonHistory = (force = false) => carbonHistoryEndpoint.load(undefined, { force });
/** The whole history of one market, cached per market. */
export const loadPowerPriceHistory = (code: string, force = false) => powerPriceHistoryEndpoint.load({ code }, { force });
