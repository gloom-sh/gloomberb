import { expect, test } from "bun:test";
import type { HeadlessPaneContext } from "../../../types/headless";
import { createDefaultConfig } from "../../../types/config";
import { portfolioRiskHeadless } from "./risk-headless";

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
  await expect(portfolioRiskHeadless.load({ ...args, rawArgument: "someone-else" }, context)).rejects.toThrow("Unknown local portfolio");
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
    portfolio: { id: "broker:ibkr:U1", name: "Interactive Brokers", currency: "USD" },
    holdings,
    book: { gross: 100_000, net: 98_000 },
    fetchedAt: "2026-10-01T12:00:00.000Z",
    complete: false,
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
    complete: false,
    errors: ["Basket risk supports at most 80 holdings"],
    sections: Object.entries(model.rows).map(([title, rows]) => ({ title, rows })),
    metadata: { model },
  };
  const args = (view: string) => ({ rawArgument: "", argument: null, symbols: [], options: { view } });

  const correlation = portfolioRiskHeadless.compact!(full as never, args("correlation"));
  expect(correlation.sections.map((section) => section.title)).toEqual(["correlation"]);
  expect(correlation.metadata?.model).toBeUndefined();
  expect(correlation.metadata).toMatchObject({ view: "correlation", holdings: 120, grossValue: 100_000, portfolio: { id: "broker:ibkr:U1" } });
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
