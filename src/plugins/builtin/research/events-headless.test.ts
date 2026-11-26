import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createEventsHeadless } from "./events-headless";
import { createEarningsEstimatesHeadless } from "./headless";
import { loadEventSources } from "./event-sources";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { catalystFixture, catalystPayload } from "../catalysts/test-fixture";

const args: HeadlessPaneLoadArgs = {
  rawArgument: "AAPL", argument: "AAPL", symbols: ["AAPL"], options: {},
};

test("EE and EVT keep calendar EPS and count without borrowing quarter growth in text or metadata", async () => {
  const marketData = createTestDataProvider({
    getCorporateActions: async () => ({ symbol: "DELL", currency: "USD", splits: [], dividends: [],
      earnings: [{ date: "2099-02-25", currency: "USD", epsEstimate: 8.58, epsAnalysts: 22 }] }),
    getAnalystResearch: async () => ({ symbol: "DELL", currency: "USD", ratings: [], recommendations: [], revenueEstimates: [],
      earningsEstimates: [{ date: "2099-01-31", period: "current_quarter", average: 8.52486, analysts: 19, growth: 1.1915 }] }),
    getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
  });
  const request = { ...args, rawArgument: "DELL", argument: "DELL", symbols: ["DELL"] };
  for (const [command, definition] of [["EE", createEarningsEstimatesHeadless()], ["EVT", createEventsHeadless()]] as const) {
    const result = await definition.load(request, { marketData } as HeadlessPaneContext);
    expect(result.metadata?.nextUp).toContainEqual({ id: "eps-estimate", label: "EPS est", value: "8.58 USD", detail: "22 analysts" });
    const text = renderHeadlessPaneText(definition, result, request, command);
    expect(text).toMatch(/^\s*EPS est\s+8\.58 USD\s+22 analysts *$/m);
    expect(result.rows.find((row) => row.status === "Q Est")).toMatchObject({ estimateGrowth: 1.1915 });
  }
});

describe("corporate actions headless model", () => {
  test("named ETF actions disqualify calendar EPS even without financials and keep splits and uncertain payout gaps", async () => {
    const symbol = "NIFTYBEES.NS";
    const fundArgs = { ...args, rawArgument: symbol, argument: symbol, symbols: [symbol] };
    let analystReads = 0;
    const marketData = createTestDataProvider({
      getCorporateActions: async () => ({ symbol, name: "Nippon India ETF Nifty 50 BeES", exchange: "NSE", currency: "INR",
        coverage: { dividends: "unavailable" }, splits: [{ date: "2020-03-02", fromFactor: 1, toFactor: 10 }],
        dividends: [{ exDate: "2019-02-18", amount: 0.8 }, { exDate: "2021-02-18", amount: 0.5 }], earnings: [] }),
      getTickerFinancials: async () => { throw new Error("Financials source timed out"); },
      getAnalystResearch: async () => { analystReads++; throw new Error("Analyst source unavailable"); },
      getEarningsCalendar: async () => [{ symbol, name: "Nifty 50 BeES", earningsDate: new Date("2099-03-01"), isDateEstimate: true,
        epsEstimate: 6, epsActual: null, revenueEstimate: null, revenueActual: null, surprise: null, timing: "" }],
    });
    const sources = await loadEventSources(marketData, symbol);
    expect(sources.actions?.earnings).toEqual([]);
    const context = { marketData } as HeadlessPaneContext;
    const events = await createEventsHeadless().load(fundArgs, context);
    expect(events.rows.map((row) => row.status)).toEqual(["Dividend", "Split", "Dividend"]);
    expect(events.textRows?.find((row) => row.year === "2020")?.detail).toBe("Distribution history incomplete · 10-for-1 split");
    expect(events.metadata?.coverage).toMatchObject({ dividends: "unavailable" });
    const estimates = await createEarningsEstimatesHeadless().load(fundArgs, context);
    expect(estimates.rows).toEqual([]);
    expect(estimates.metadata?.nextUp).toBeUndefined();
    expect(analystReads).toBe(0);
  });
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

  test("fn EVT prints the pane's views: what is next, the quarters, and the years paid with the splits that went ex in them", async () => {
    const marketData = createTestDataProvider({
      getCorporateActions: async () => ({ symbol: "AAPL", currency: "USD",
        splits: [{ date: "2020-08-31", fromFactor: 1, toFactor: 4 }],
        // Nothing paid in 2020 or 2021: a gap, broken where the split went ex.
        dividends: [2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024].map((year) => ({ exDate: `${year}-05-10`, amount: 0.25 })),
        earnings: [{ date: "2024-08-01", epsActual: 1.4, epsEstimate: 1.35, currency: "USD", fiscalPeriod: "2024-06" }] }),
      getAnalystResearch: async () => null as never,
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    });
    const result = await createEventsHeadless().load(args, { marketData } as HeadlessPaneContext);
    // The exports keep every event row; the text report reads as the views do.
    expect(result.rows.filter((row) => row.status === "Dividend")).toHaveLength(8);
    expect(result.rows.find((row) => row.status === "Split")).toMatchObject({ date: "2020-08-31", detail: "4-for-1" });
    expect(result.notes).toBeUndefined();
    expect(result.textRows?.map((row) => [row.date, row.eps, row.estimate, row.surprise])).toEqual([["2024-08-01", "1.40 USD", "1.35 USD", "—"]]);
    const [nextUp, years] = result.textSections ?? [];
    expect(nextUp?.entries?.map((entry) => entry.formatted)).toEqual(["10 May 2024  $0.25"]);
    expect(years?.rows?.map((row) => `${row.year} ${row.paid} ${row.detail}`.trim())).toEqual([
      "2024 0.25 USD", "2023 0.25 USD", "2022 0.25 USD", "2021  no dividend", "2020  no dividend · 4-for-1 split",
      "2019 0.25 USD", "2018 0.25 USD", "2017 0.25 USD", "2016 0.25 USD", "2015 0.25 USD"]);
  });

  describe("the next catalyst", () => {
    const marketData = createTestDataProvider({
      getCorporateActions: async () => ({ symbol: "AAPL", currency: "USD", splits: [], dividends: [{ exDate: "2024-05-10", amount: 0.25 }],
        earnings: [{ date: "2024-08-01", epsActual: 1.4, epsEstimate: 1.35, currency: "USD", fiscalPeriod: "2024-06" }] }),
      getAnalystResearch: async () => null as never,
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    });
    const load = (getCloudCatalysts: (query: unknown) => Promise<unknown>) => createEventsHeadless()
      .load(args, { marketData, apiClient: { getCloudCatalysts } } as unknown as HeadlessPaneContext);

    test("is read from the catalyst calendar as the pane reads it, the earliest one ahead", async () => {
      const queries: unknown[] = [];
      const event = (id: string, deadlineDate: string, title: string) => ({ ...catalystFixture, id, title, deadlineDate, datePrecision: { deadline: "day" as const } });
      const result = await load(async (query) => {
        queries.push(query);
        return { ...catalystPayload(), total: 3, events: [event("later", "2099-06-01", "Court hearing"), event("past", "2001-01-01", "Old ruling"), event("next", "2099-03-15", "FDA decision")] };
      });
      expect(queries).toEqual([{ symbol: "AAPL", upcoming: true, dateField: "any", limit: 20, offset: 0 }]);
      const catalyst = result.textSections?.[0]?.entries?.find((entry) => entry.label === "Next catalyst");
      expect(catalyst?.formatted).toStartWith("15 Mar 2099");
      expect(catalyst?.formatted).toContain("FDA decision");
      expect(result.metadata?.nextUp).toContainEqual(expect.objectContaining({ id: "next-catalyst", value: "15 Mar 2099" }));
      expect(result.errors).toBeUndefined();
    });

    test("a free preview names its first row only while its rows come earliest first, as the pane does", async () => {
      const event = (id: string, deadlineDate: string) => ({ ...catalystFixture, id, title: id, deadlineDate, datePrecision: { deadline: "day" as const } });
      const preview = (events: ReturnType<typeof event>[]) => async () => ({ ...catalystPayload(), total: 200, events,
        access: { pro: false, lockedRows: 197, previewLimit: 3, lockedUpcoming: 197 } });
      const inOrder = await load(preview([event("FDA decision", "2099-03-15"), event("Court hearing", "2099-06-01")]));
      expect(inOrder.textSections?.[0]?.entries?.find((entry) => entry.label === "Next catalyst")?.formatted).toContain("FDA decision");
      const outOfOrder = await load(preview([event("Court hearing", "2099-06-01"), event("FDA decision", "2099-03-15")]));
      expect(outOfOrder.textSections?.[0]?.entries?.map((entry) => entry.label)).toEqual(["Last ex"]);
      expect(outOfOrder.errors).toBeUndefined();
    });

    test("a failed read is said and the rest stands; signed out, the figure is only left out", async () => {
      const failed = await load(async () => { throw new Error("Catalyst calendar timed out"); });
      expect(failed.errors).toEqual(["Catalysts unavailable: Catalyst calendar timed out"]);
      expect(failed.textRows).toHaveLength(1);
      expect(failed.textSections?.[0]?.entries?.map((entry) => entry.label)).toEqual(["Last ex"]);
      const signedOut = await load(async () => { throw new Error("Gloom Cloud requires signup and email verification"); });
      expect(signedOut.errors).toBeUndefined();
      expect(signedOut.textSections?.[0]?.entries?.map((entry) => entry.label)).toEqual(["Last ex"]);
    });
  });
});
