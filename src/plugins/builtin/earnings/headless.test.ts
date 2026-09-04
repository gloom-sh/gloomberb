import { describe, expect, test } from "bun:test";
import type { EarningsEvent } from "../../../types/data-provider";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createEarningsCalendarHeadless } from "./headless";

const events: EarningsEvent[] = [
  {
    symbol: "MSFT",
    name: "Microsoft",
    earningsDate: new Date("2026-09-08T20:00:00.000Z"),
    earningsCallDate: new Date("2026-09-08T21:00:00.000Z"),
    isDateEstimate: false,
    epsEstimate: 3.67,
    epsLow: 3.5,
    epsHigh: 3.8,
    epsGrowth: 0.12,
    epsTrend30dAgo: 3.55,
    epsRevisionUp30d: 8,
    epsRevisionDown30d: 2,
    epsActual: null,
    revenueEstimate: 74_000_000_000,
    revenueLow: 72_000_000_000,
    revenueHigh: 76_000_000_000,
    revenueGrowth: 0.16,
    revenueActual: null,
    surprise: null,
    timing: "AMC",
  },
  {
    symbol: "AAPL",
    name: "Apple",
    earningsDate: new Date("2026-09-07T12:00:00.000Z"),
    epsEstimate: 1.5,
    epsActual: null,
    revenueEstimate: 95_000_000_000,
    revenueActual: null,
    surprise: null,
    timing: "BMO",
  },
];

function args(options: Record<string, string | number | boolean>): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AAPL,MSFT",
    argument: ["AAPL", "MSFT"],
    symbols: ["AAPL", "MSFT"],
    options,
  };
}

const context = {} as HeadlessPaneContext;

describe("earnings calendar headless", () => {
  test("maps provider events into date-ordered rows", async () => {
    const definition = createEarningsCalendarHeadless({
      loadCalendar: async () => ({ events, fetchedAt: 123, stale: false }),
    });

    const result = await definition.load(args({ timing: "all", limit: 50 }), context);

    expect(result.rows.map((row) => row.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(result.rows[1]).toMatchObject({
      date: "2026-09-08T20:00:00.000Z",
      timing: "AMC",
      dateStatus: "confirmed",
      epsEstimate: 3.67,
      revenueEstimate: 74_000_000_000,
    });
  });

  test("applies timing and limit options", async () => {
    const definition = createEarningsCalendarHeadless({
      loadCalendar: async () => ({ events, fetchedAt: 123, stale: false }),
    });

    const result = await definition.load(args({ timing: "AMC", limit: 1 }), context);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.symbol).toBe("MSFT");
    expect(result.metadata).toMatchObject({ timing: "AMC", returned: 1 });
  });
});
