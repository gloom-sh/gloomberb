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
