import { describe, expect, test } from "bun:test";
import type { PsdBoardPayload } from "../../../api-client/commodity-balances";
import { ApiRequestError } from "../../../api-client/errors";
import { CROPS_NOT_AVAILABLE, fetchCommodityBalances } from "./client";

const payload = (overrides: Partial<PsdBoardPayload> = {}): PsdBoardPayload => ({
  source: "USDA",
  status: "available",
  checkedAt: "2026-10-16T06:00:00.000Z",
  stale: false,
  gaps: [],
  month: "2026-10",
  marketYear: "2026/27",
  rows: [{
    id: "Wheat|China|Production", crop: "Wheat", country: "China", attribute: "Production",
    value: 141000, unit: "1000 MT", year: "2026/27", cropOrder: 0, countryOrder: 0, attributeOrder: 0,
  }],
  prices: [{ id: "Wheat|2026/27", crop: "Wheat", forecast: 6.593635, unit: "$/bu", season: "2026/27", cropOrder: 0, seasonYear: 2026 }],
  pricesDate: "2026-10-01",
  ...overrides,
});
const serving = (answer: () => Promise<PsdBoardPayload>) => ({ getCloudPsdBoard: answer });

describe("crop balances from Gloom Cloud", () => {
  test("the board, its market year and the month of the estimates", async () => {
    const data = await fetchCommodityBalances(undefined, serving(async () => payload()));
    expect(data).toMatchObject({ marketYear: "2026/27", month: "2026-10", stale: false, gaps: [] });
    expect(data.rows).toHaveLength(1);
    expect(data.prices[0]?.forecast).toBe(6.593635);
  });

  test("a server without the board yet says so; a broken board is refused whole", async () => {
    await expect(fetchCommodityBalances(undefined, serving(async () => { throw new ApiRequestError("Unavailable", 503); })))
      .rejects.toThrow(CROPS_NOT_AVAILABLE);
    await expect(fetchCommodityBalances(undefined, serving(async () => payload({ status: "unavailable", rows: [] }))))
      .rejects.toThrow(CROPS_NOT_AVAILABLE);
    const broken = payload();
    broken.rows[0] = { ...broken.rows[0]!, value: Number.NaN };
    await expect(fetchCommodityBalances(undefined, serving(async () => broken))).rejects.toThrow("invalid crop balance board");
  });
});
