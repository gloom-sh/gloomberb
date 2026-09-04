import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createIpoCalendarHeadless } from "./headless";
import type { IPORecord } from "./types";

const records: IPORecord[] = [
  {
    ticker: "ALFA",
    companyName: "Alpha Labs",
    date: new Date("2026-09-10T00:00:00.000Z"),
    status: "upcoming",
    exchange: "NASDAQ",
    offerSize: 120_000_000,
    priceRange: [18, 20],
    pricedPrice: null,
    shares: 6_000_000,
    closePrice: null,
    change1D: null,
  },
  {
    ticker: "BETA",
    companyName: "Beta Systems",
    date: new Date("2026-09-03T00:00:00.000Z"),
    status: "trading",
    exchange: "NYSE",
    offerSize: null,
    priceRange: null,
    pricedPrice: 24,
    shares: null,
    closePrice: 30,
    change1D: 25,
  },
];

function args(
  argument: string | null = null,
  options: Record<string, string | number | boolean> = { status: "all", limit: 50 },
): HeadlessPaneLoadArgs {
  return {
    rawArgument: argument ?? "",
    argument,
    symbols: [],
    options,
  };
}

const context = {} as HeadlessPaneContext;

describe("IPO calendar headless", () => {
  test("maps IPO records into structured rows", async () => {
    const definition = createIpoCalendarHeadless({
      loadCalendar: async () => ({
        records,
        fetchedAt: 123,
        stale: false,
        errors: [],
      }),
    });

    const result = await definition.load(args("alpha"), context);

    expect(result.rows).toEqual([{
      ticker: "ALFA",
      company: "Alpha Labs",
      date: "2026-09-10",
      status: "upcoming",
      exchange: "NASDAQ",
      offerSize: 120_000_000,
      priceLow: 18,
      priceHigh: 20,
      pricedPrice: null,
      shares: 6_000_000,
      closePrice: null,
      change1D: null,
    }]);
    expect(result.metadata).toMatchObject({ total: 1, returned: 1, truncated: false });
  });

  test("applies status and limit options", async () => {
    const definition = createIpoCalendarHeadless({
      loadCalendar: async () => ({ records, fetchedAt: 123, stale: false, errors: [] }),
    });

    const result = await definition.load(args(null, { status: "trading", limit: 1 }), context);

    expect(result.rows.map((row) => row.ticker)).toEqual(["BETA"]);
    expect(result.metadata).toMatchObject({ status: "trading", returned: 1 });
  });
});
