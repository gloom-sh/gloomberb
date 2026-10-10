import { expect, setSystemTime, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createDefaultConfig } from "../../../types/config";
import { portfolioRiskHeadless } from "./risk-headless";
import { BROKER_PORTFOLIO, brokerFixtureTickers, brokerRiskClient, now } from "./risk-test-data";

test("local evidence reports keep account identity and work without market network access", async () => {
  const portfolio = { id: "local", name: "Local account", currency: "USD" };
  const evidence = { version: 1, portfolioId: portfolio.id, currency: "USD", source: "Illustrative ledger", performance: {
    flowTiming: "end-of-day", externalFlowsComplete: true, observations: [
      { date: "2025-01-02", value: 100, externalFlow: 0 }, { date: "2026-01-02", value: 125, externalFlow: 0 },
    ],
  } };
  const requested: string[] = [];
  const context = { config: { ...createDefaultConfig("/tmp/unused-risk-headless"), portfolios: [portfolio] }, signal: new AbortController().signal,
    apiClient: new Proxy({}, { get() { throw new Error("Unexpected market network access"); } }),
    resolvePortfolio: async (id: string) => { requested.push(id); return id === portfolio.id ? { portfolio, tickers: [] } : null; },
  } as unknown as HeadlessPaneContext;
  const args = { rawArgument: "local", argument: "local", symbols: [], options: { view: "performance", evidence: JSON.stringify(evidence) } };
  const result = await portfolioRiskHeadless.load(args, context);
  expect(requested).toEqual(["local"]); expect(result.complete).toBe(true);
  const rows = (result.metadata as { model: { rows: Record<string, Array<{ id: string; value: number | null }>> } }).model.rows.performance!;
  expect(rows.find(row => row.id === "twr")!.value).toBe(25);
  expect(rows.find(row => row.id === "mwr")!.value).toBeCloseTo(25, 8);
  expect(result.sections.find(row => row.title === "performance")!.rows![0]).toMatchObject({ value: expect.stringMatching(/%$/) });
  // The error names the ids that exist, so a guessed id ("default") is fixed in one more call.
  await expect(portfolioRiskHeadless.load({ ...args, rawArgument: "default" }, context)).rejects.toThrow("Unknown local portfolio: default. Portfolio IDs: local.");
  await expect(portfolioRiskHeadless.load({ ...args, options: { ...args.options, evidence: JSON.stringify({ ...evidence, currency: "EUR" }) } }, context)).rejects.toThrow("different portfolio or currency");
});

function riskRow(id: string, value: number | null, unit = "% gross") {
  return { id, label: id, value, unit, percentile: null, asOf: "2026-10-01T00:00:00.000Z", detail: `${id} evidence` };
}

test("the compact result is the requested view, without the model, with the strongest pairs", () => {
  const holdings = Array.from({ length: 120 }, (_, index) => ({ id: `NASDAQ:H${index}`, symbol: `H${index}`, value: 1_000 - index }));
  const pairs = holdings.flatMap((left, index) => holdings.slice(index + 1).map((right, offset) => (
    riskRow(`${left.id}/${right.id}`, ((index * 7 + offset) % 199) / 100 - 0.99, "correlation")
  )));
  pairs[42] = { ...pairs[42]!, value: -0.995 };
  const model = {
    portfolio: { id: "broker:test:U1", name: "Broker account", currency: "USD" },
    holdings,
    fetchedAt: "2026-10-01T12:00:00.000Z",
    complete: true,
    coverage: { currency: "USD", marketValue: 100_000, coveredValue: 100_000, share: 1, holdings: 120, covered: 120, unvalued: 0, minimumShare: 0.5, sufficient: true, leftOut: [] },
    rows: {
      risk: [riskRow("vol", 12.5, "%")],
      factors: [],
      holdings: holdings.map((holding) => riskRow(holding.symbol, holding.value / 1_000)),
      correlation: pairs,
      stress: [],
      performance: [],
      attribution: [],
      greeks: [],
    },
  };
  const full = {
    complete: true,
    errors: ["Treasury yield: Internal server error"],
    sections: Object.entries(model.rows).map(([title, rows]) => ({ title, rows })),
    metadata: { model },
  };
  const args = (view: string) => ({ rawArgument: "", argument: null, symbols: [], options: { view } });

  const correlation = portfolioRiskHeadless.compact!(full as never, args("correlation"));
  expect(correlation.sections.map((section) => section.title)).toEqual(["correlation"]);
  expect(correlation.metadata?.model).toBeUndefined();
  expect(correlation.metadata).toMatchObject({ view: "correlation", coverage: { share: 1, holdings: 120, leftOut: [] }, portfolio: { id: "broker:test:U1" } });
  const strongest = correlation.sections[0]!.rows!;
  expect(strongest).toHaveLength(25);
  expect(strongest[0]!.label).toBe(pairs[42]!.label);
  expect(correlation.metadata?.notices).toEqual([`Strongest 25 of ${pairs.length} pairs by absolute correlation.`]);
  expect(correlation.errors).toEqual(full.errors);

  const book = portfolioRiskHeadless.compact!(full as never, args("holdings"));
  expect(book.sections[0]!.rows).toHaveLength(100);
  expect(book.metadata?.notices).toEqual(["20 more holdings rows not shown."]);

  // The report keeps every view and the model.
  expect(full.sections).toHaveLength(8);
  expect(full.metadata.model).toBe(model);
});

test("the report and its compact form state what the basket covers and why each holding is left out", async () => {
  setSystemTime(now);
  try {
    const tickers = brokerFixtureTickers();
    const context = {
      config: { ...createDefaultConfig("/unused/risk-headless"), portfolios: [BROKER_PORTFOLIO] },
      signal: new AbortController().signal,
      apiClient: brokerRiskClient(now),
      resolvePortfolio: async () => ({ portfolio: BROKER_PORTFOLIO, tickers }),
    } as unknown as HeadlessPaneContext;
    const args = { rawArgument: BROKER_PORTFOLIO.id, argument: BROKER_PORTFOLIO.id, symbols: [], options: { view: "risk" } };
    const full = await portfolioRiskHeadless.load(args, context);
    expect(full.complete).toBe(false);
    expect(full.metadata?.coverage).toMatchObject({ holdings: 94, covered: 85, estimated: true, shareIsUpperBound: false });
    // What the estimate leaves out is a note; the report itself did not fail.
    expect(full.errors).toEqual([]);
    expect(full.notes).toContain("TWD1 (4.0% of market value) is excluded from the risk estimate: foreign holdings: daily FX closes unavailable.");
    // Every risk row is a number, not a dash.
    expect(full.sections.find((section) => section.title === "risk")!.rows!.every((row) => row.value !== "--")).toBe(true);

    const compact = portfolioRiskHeadless.compact!(full, args);
    expect(compact.notes).toEqual(["Basket covers 78% of market value \u00b7 9 holdings left out; metadata.coverage lists each with its reason."]);
    expect(compact.errors).toBeUndefined();
    const coverage = compact.metadata?.coverage as { share: number; leftOut: Array<{ symbol: string; reason: string; share: number }> };
    expect(coverage.share).toBeCloseTo(365_500 / 468_560, 10);
    expect(coverage.leftOut[0]).toMatchObject({ symbol: "EUR2", reason: "Foreign holdings: daily FX closes unavailable" });
    expect(coverage.leftOut[0]!.share).toBeCloseTo(20_020 / 468_560, 10);
    expect(coverage.leftOut.at(-1)).toMatchObject({ symbol: "UNQ3", reason: "Daily history unavailable" });

    // With nothing but crypto the basket views have no estimate: a failure the report states, beside the note naming the holding.
    const crypto = brokerFixtureTickers([{ symbol: "ETH-USD", exchange: "CCC", currency: "USD", quantity: 2, price: 2_500, brokerValue: 5_000 }]);
    const cryptoOnly = await portfolioRiskHeadless.load(args, { ...context, resolvePortfolio: async () => ({ portfolio: BROKER_PORTFOLIO, tickers: crypto }) } as unknown as HeadlessPaneContext);
    expect(cryptoOnly.errors).toEqual([expect.stringContaining("Basket estimates unavailable: No holding qualifies")]);
    expect(cryptoOnly.notes).toEqual(["ETH-USD (100.0% of market value) is excluded from the risk estimate: crypto is not covered by the equity basket."]);
  } finally {
    setSystemTime();
  }
});
