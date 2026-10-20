import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { FundBondFacts } from "../../../api-client/fund-facts";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { createDividendYieldHeadless } from "./headless";

const quote = { symbol: "MUNI", currency: "USD", price: 100, change: 0, changePercent: 0,
  lastUpdated: Date.parse("2026-10-19T20:00:00Z"), instrumentType: "ETF", exchangeName: "NYSE" };
const bond: FundBondFacts = { kind: "municipal", state: null,
  secYield: { value: 4, asOf: "2026-10-19", source: "Fixture", url: "https://fixture.invalid/fund" },
  yieldToWorst: null, duration: null };

afterEach(() => {
  spyOn(apiClient, "getMarketDividends").mockRestore();
  setHttpFetchTransport(null);
});

function fixture(failure: "quote" | "facts" | "none", facts: FundBondFacts | null = bond) {
  // Block transport entirely: every dependency below is a fixture.
  setHttpFetchTransport(async () => { throw new Error("Unexpected fixture request"); });
  spyOn(apiClient, "getMarketDividends").mockResolvedValue({ status: "success", data: {
    actions: { symbol: "MUNI", currency: "USD", providerId: "gloomberb-cloud", coverage: { dividends: "available" },
      dividends: [{ exDate: "2026-10-01", amount: 1 }], splits: [], earnings: [] },
    quote: { ...quote, providerId: "gloomberb-cloud", dataSource: "live" },
    summary: { currency: "USD", trailingAnnualDividendRate: null, trailingAnnualDividendYield: null,
      forwardAnnualDividendRate: null, payoutRatio: null, exDividendDate: null, dividendDate: null },
  } });
  let quoteReads = 0;
  let factsReads = 0;
  const context = createTestHeadlessContext({
    resolveInstrument: async () => ({ symbol: "MUNI", exchange: "NYSE" }),
    marketData: createTestDataProvider({ getQuote: async () => {
      // The reference quote succeeds; the independent classification check fails.
      if (++quoteReads === 2 && failure === "quote") throw new Error("Fixture quote unavailable");
      return quote;
    } }),
    apiClient: {
      getFundFacts: async () => {
        factsReads++;
        if (failure === "facts") throw new Error("Fixture facts unavailable");
        return { bond: facts };
      },
      getCloudCurve: async () => ({ asOf: "2026-10-19", points: [{ tenor: "5Y", years: 5, yield: 4 }] }),
    } as unknown as typeof apiClient,
  });
  return { context, factsReads: () => factsReads };
}

for (const failure of ["quote", "facts"] as const) {
  test(`a failed bond-fund ${failure} check makes the tax report incomplete without losing cash history`, async () => {
    const { context, factsReads } = fixture(failure);
    const definition = createDividendYieldHeadless();
    const args = createTestHeadlessArgs({ rawArgument: "MUNI", argument: "MUNI", symbols: ["MUNI"], options: { "tax-rate": "40" } });
    const result = await definition.load(args, context);
    const checkError = `Bond fund ${failure} check failed`;

    expect(result.complete).toBe(false);
    expect(result.errors).toEqual([checkError]);
    expect(result.metadata?.taxEquivalent).toMatchObject({
      checkError, taxEquivalentYield: null, muniTreasuryRatio: null, notes: [checkError],
    });
    expect(result.sections.find(section => section.title === "Dividend history")?.rows).toMatchObject([
      { exDate: "2026-10-01", amount: 1, currency: "USD" },
    ]);
    const text = renderHeadlessPaneText(definition, result, args, "DVD");
    expect(text).toContain(checkError);
    expect(text).not.toContain("is not a bond fund");
    expect(factsReads()).toBe(failure === "quote" ? 0 : 1);
  });
}

test("a successful bond check distinguishes a municipal yield from confirmed absent facts", async () => {
  const definition = createDividendYieldHeadless();
  const args = createTestHeadlessArgs({ rawArgument: "MUNI", argument: "MUNI", symbols: ["MUNI"], options: { "tax-rate": "40" } });
  for (const facts of [bond, null]) {
    const { context, factsReads } = fixture("none", facts);
    const result = await definition.load(args, context);
    expect(result.complete).not.toBe(false);
    expect(result.errors).toBeUndefined();
    const tax = result.metadata?.taxEquivalent as { checkError?: string; taxEquivalentYield: number | null; notes: string[] };
    expect(tax.checkError).toBeUndefined();
    if (facts) expect(tax.taxEquivalentYield).toBeCloseTo(4 / 0.6, 10);
    else {
      expect(tax.taxEquivalentYield).toBeNull();
      expect(tax.notes[0]).toContain("is not a bond fund");
    }
    expect(factsReads()).toBe(1);
  }
});
