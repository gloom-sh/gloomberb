import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createEventsHeadless } from "./events-headless";
import { createTestDataProvider } from "../../../test-support/data-provider";

const args: HeadlessPaneLoadArgs = {
  rawArgument: "AAPL", argument: "AAPL", symbols: ["AAPL"], options: {},
};

describe("corporate actions headless model", () => {
  test("keeps successful events while reporting failed estimates and statements", async () => {
    const marketData = createTestDataProvider({
      getCorporateActions: async () => ({ symbol: "NVDA", currency: "USD", dividends: [{ exDate: "2024-03-05", amount: 0.004 }], splits: [], earnings: [] }),
      getAnalystResearch: async () => { throw new Error("Analyst source timed out"); },
      getTickerFinancials: async () => { throw new Error("Financials source timed out"); },
    });
    const result = await createEventsHeadless().load(args, { marketData } as HeadlessPaneContext);
    expect(result.rows[0]).toMatchObject({ status: "Dividend", value: "$0.004" });
    expect(result.errors).toEqual(["Analyst estimates unavailable: Analyst source timed out", "Financial statements unavailable: Financials source timed out"]);
  });
  test("maps corporate actions through the same event projection as the pane", async () => {
    const headless = createEventsHeadless({
      load: async () => ({
        actions: {
          symbol: "AAPL",
          currency: "USD",
          dividends: [{ exDate: "2026-08-08", amount: 0.26 }],
          splits: [],
          earnings: [{ date: "2026-07-31", epsActual: 1.57, surprisePercent: 5.4 }],
        },
        estimates: null,
        financials: null,
        currency: "USD",
      }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.rows).toEqual([
      expect.objectContaining({ status: "Dividend", value: "$0.26" }),
      expect.objectContaining({ status: "Earnings", qEps: 1.57, value: "+5.40%" }),
    ]);
  });
});
