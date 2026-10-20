import { apiClient } from "../../../api-client";
import type { PsdBoardPayload } from "../../../api-client/commodity-balances";
import { unavailableOnServer } from "../shared/cloud-resource";
import type { BalanceRow, PriceForecast } from "./model";

/** What the pane says while the server has no balances to serve: before its first read of USDA's files. */
export const CROPS_NOT_AVAILABLE = "Crop balances are not available yet.";

export interface CommodityBalances {
  rows: BalanceRow[];
  prices: PriceForecast[];
  marketYear: string | null;
  /** YYYY-MM of the monthly supply and demand estimates the balances are from. */
  month: string | null;
  /** The server could not read USDA for days: these are its last copies. */
  stale: boolean;
  /** What is missing or out of date, in words. */
  gaps: string[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const validRow = (row: BalanceRow) => [row.id, row.crop, row.country, row.attribute, row.unit, row.year].every(text)
  && [row.value, row.cropOrder, row.countryOrder, row.attributeOrder].every(finite)
  && (row.month == null || (text(row.month) && MONTH.test(row.month)));
const validPrice = (row: PriceForecast) => [row.id, row.crop, row.unit, row.season].every(text)
  && [row.forecast, row.cropOrder, row.seasonYear].every(finite);

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
function readBoard(payload: PsdBoardPayload): CommodityBalances {
  if (!payload || payload.source !== "USDA" || !Array.isArray(payload.rows) || !Array.isArray(payload.prices)
    || !Array.isArray(payload.gaps) || !payload.gaps.every(text)
    || !payload.rows.every(validRow) || !payload.prices.every(validPrice)
    || (payload.month != null && !MONTH.test(payload.month))
    || (payload.marketYear != null && !text(payload.marketYear))) {
    throw new Error("The server returned an invalid crop balance board");
  }
  if (payload.status === "unavailable" || payload.rows.length === 0) throw new Error(CROPS_NOT_AVAILABLE);
  return {
    rows: payload.rows,
    prices: payload.prices,
    marketYear: payload.marketYear ?? null,
    month: payload.month ?? null,
    stale: payload.stale === true,
    gaps: payload.gaps,
  };
}

/**
 * USDA's world wheat, corn, soybean, cotton, coffee and sugar balances for the
 * latest market year, and the season-average price forecasts. Gloom Cloud reads USDA's
 * files; a route the server does not serve yet (404) or cannot read (503) is
 * the not-available message.
 */
export async function fetchCommodityBalances(
  signal?: AbortSignal,
  client: Pick<typeof apiClient, "getCloudPsdBoard"> = apiClient,
): Promise<CommodityBalances> {
  let payload: PsdBoardPayload;
  try {
    payload = await client.getCloudPsdBoard(signal);
  } catch (error) {
    throw unavailableOnServer(error, CROPS_NOT_AVAILABLE, [404, 503]);
  }
  return readBoard(payload);
}
