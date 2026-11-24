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

  test("a stopped listing keeps its own events after its last trade, and drops only reports shown to be another listing's", async () => {
    const load = async (profile: { name?: string; country?: string }) => {
      const marketData = createTestDataProvider({
        getCorporateActions: async () => ({ symbol: "STPP", currency: "USD", splits: [],
          // A cash-out after the last session is the issuer's own.
          dividends: [{ exDate: "2019-06-03", amount: 0.1 }, { exDate: "2020-08-03", amount: 24.9 }],
          earnings: [{ date: "2026-01-14", dateType: "announcement", epsActual: 0.18, epsEstimate: 0.2 }] }),
        getAnalystResearch: async () => null as never,
        getTickerFinancials: async () => ({ quote: undefined, profile, annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
        getQuoteMetadata: async () => null,
        getPriceHistoryWithMetadata: async () => ({ points: [{ date: new Date("2020-07-16T00:00:00Z"), close: 24.9 }], resolution: null,
          delisting: { status: "inactive", lastTradeDate: "2020-07-16", historyStart: "2016-01-04" } }),
      });
      const stpp = { ...args, rawArgument: "STPP", argument: "STPP", symbols: ["STPP"] };
      return createEventsHeadless().load(stpp, { marketData } as HeadlessPaneContext);
    };
    // STPP: the research under the symbol is a fund domiciled abroad's, so its 2026 report is not the ETN's.
    const abroad = await load({ name: "State Street SPDR MSCI Europe Materials UCITS ETF", country: "NL" });
    expect(abroad.rows.map((row) => `${row.date} ${row.status}`)).toEqual(["2020-08-03 Dividend", "2019-06-03 Dividend"]);
    expect(abroad.notes).toEqual(["STPP last traded 2020-07-16; no longer listed. "
      + "1 later report is another listing's (State Street SPDR MSCI Europe Materials UCITS ETF), not shown."]);
    // Nothing says the research is anyone else's: every event stays.
    const own = await load({ name: "iPath US Treasury Steepener ETN", country: "US" });
    expect(own.rows.map((row) => row.status)).toEqual(["Earnings", "Dividend", "Dividend"]);
    expect(own.notes).toEqual(["STPP last traded 2020-07-16; no longer listed."]);
  });

  test("fn EVT prints the pane's views: what is next, the quarters, the years paid, and names fn DVD for every payment", async () => {
    const marketData = createTestDataProvider({
      getCorporateActions: async () => ({ symbol: "AAPL", currency: "USD", splits: [],
        // Nothing paid in 2020 or 2021: one gap, not two years of blanks.
        dividends: [2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024].map((year) => ({ exDate: `${year}-05-10`, amount: 0.25 })),
        earnings: [{ date: "2024-08-01", epsActual: 1.4, epsEstimate: 1.35, currency: "USD", fiscalPeriod: "2024-06" }] }),
      getAnalystResearch: async () => null as never,
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    });
    const result = await createEventsHeadless().load(args, { marketData } as HeadlessPaneContext);
    // The exports keep the event rows, the last three years of dividends among them.
    expect(result.rows.filter((row) => row.status === "Dividend").map((row) => row.date)).toEqual(["2024-05-10", "2023-05-10", "2022-05-10"]);
    expect(result.notes).toEqual(["The exports list the dividends of the last three years; every payment is in DVD: gloom fn DVD AAPL"]);
    expect(result.metadata).toMatchObject({ earlierDividends: { count: 5, latestExDate: "2019-05-10" } });
    expect(result.textRows?.map((row) => [row.date, row.eps, row.estimate, row.surprise])).toEqual([["2024-08-01", "1.40 USD", "1.35 USD", "+3.70%"]]);
    const [nextUp, years] = result.textSections ?? [];
    expect(nextUp?.entries?.map((entry) => entry.formatted)).toEqual(["10 May 2024  $0.25"]);
    expect(years?.rows?.map((row) => `${row.year} ${row.paid}`)).toEqual([
      "2024 0.25 USD", "2023 0.25 USD", "2022 0.25 USD", "2020-2021 ", "2019 0.25 USD", "2018 0.25 USD", "2017 0.25 USD", "2016 0.25 USD", "2015 0.25 USD"]);
  });
});
