import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { resetValuationPersistence } from "./cache";
import { marketValuationHeadless } from "./headless";

beforeEach(resetValuationPersistence);
afterEach(resetValuationPersistence);

function loadArgs(): HeadlessPaneLoadArgs {
  return {
    rawArgument: "cape",
    argument: "cape",
    symbols: [],
    options: { range: "10Y" },
  };
}

describe("market valuation headless model", () => {
  test("loads through the injected cloud client and produces bundle sections", async () => {
    let shillerCalls = 0;
    const apiClient = {
      getCloudFredSeries: async () => { throw new Error("unexpected FRED request"); },
      getCloudHistory: async () => { throw new Error("unexpected history request"); },
      getCloudShiller: async () => {
        shillerCalls += 1;
        return {
          observations: [
            { date: "2024-01-01", price: 4800, dividend: 70, earnings: 180, cpi: 310, longRate: 4, cape: 32, excessCapeYield: 0.02 },
            { date: "2025-01-01", price: 5900, dividend: 76, earnings: 200, cpi: 320, longRate: 4.2, cape: 36, excessCapeYield: 0.015 },
            { date: "2026-01-01", price: 6300, dividend: 80, earnings: 220, cpi: 330, longRate: 4.4, cape: 39, excessCapeYield: 0.01 },
          ],
          sourceUrl: "https://example.test/shiller.xls",
          fetchedAt: "2026-01-02T00:00:00Z",
        };
      },
    } as unknown as HeadlessPaneContext["apiClient"];
    const context: HeadlessPaneContext = {
      marketData: createTestDataProvider(),
      apiClient,
      config: createDefaultConfig("/tmp/gloomberb-headless-valuation"),
      signal: new AbortController().signal,
    };

    const result = await marketValuationHeadless.load(loadArgs(), context);

    expect(shillerCalls).toBe(1);
    expect(result.sections.map(({ title }) => title)).toEqual([
      "Market valuation",
      "Shiller CAPE",
    ]);
    expect(result.sections[0]).toMatchObject({
      rows: [{ id: "shiller-cape", value: 39, formattedValue: "39.0" }],
    });
    expect(result.metadata).toMatchObject({ range: "10Y", selected: "shiller-cape" });
  });
});
