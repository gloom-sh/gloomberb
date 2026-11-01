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

  test("a symbol whose listing stopped trading keeps its own events and says the later ones are another listing's", async () => {
    // STPP: the iPath steepener stopped in 2020; the feed's 2026 earnings are a fund abroad's under the symbol.
    const marketData = createTestDataProvider({
      getCorporateActions: async () => ({ symbol: "STPP", currency: "USD", splits: [],
        dividends: [{ exDate: "2019-06-03", amount: 0.1 }],
        earnings: [{ date: "2026-01-14", dateType: "announcement", epsActual: 0.18, epsEstimate: 0.2 }] }),
      getAnalystResearch: async () => null as never,
      getTickerFinancials: async () => ({ quote: undefined, annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getQuoteMetadata: async () => null,
      getPriceHistoryWithMetadata: async () => ({ points: [{ date: new Date("2020-07-16T00:00:00Z"), close: 24.9 }], resolution: null,
        delisting: { status: "inactive", lastTradeDate: "2020-07-16", historyStart: "2016-01-04" } }),
    });
    const stpp = { ...args, rawArgument: "STPP", argument: "STPP", symbols: ["STPP"] };
    const result = await createEventsHeadless().load(stpp, { marketData } as HeadlessPaneContext);
    expect(result.rows.map((row) => row.status)).toEqual(["Dividend"]);
    expect(result.notes).toEqual(["STPP last traded 2020-07-16; no longer listed. 1 later event is another listing's under the symbol, not shown."]);
  });
});
