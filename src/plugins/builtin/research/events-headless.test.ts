import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createEventsHeadless } from "./events-headless";

const args: HeadlessPaneLoadArgs = {
  rawArgument: "AAPL", argument: "AAPL", symbols: ["AAPL"], options: {},
};

describe("corporate actions headless model", () => {
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
