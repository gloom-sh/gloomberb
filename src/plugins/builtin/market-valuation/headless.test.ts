import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { resetValuationPersistence } from "./cache";
import { marketValuationHeadless } from "./headless";
import { createTestHeadlessContext } from "../../../test-support/headless";

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
    const fredRequests: string[] = [];
    const apiClient = {
      getCloudFredSeries: async (seriesId: string) => {
        fredRequests.push(seriesId);
        if (seriesId === "GDP") return { observations: [{ date: "2025-01-01", value: 30_000 }], fetchedAt: "2026-01-02T00:00:00Z", stale: false };
        if (seriesId === "NCBEILQ027S" || seriesId === "FBCELLQ027S") {
          return { observations: [{ date: "2025-01-01", value: 24_000_000 }], fetchedAt: "2026-01-02T00:00:00Z", stale: false };
        }
        throw new Error(`unexpected FRED request ${seriesId}`);
      },
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
    const context = createTestHeadlessContext({ apiClient });
    const result = await marketValuationHeadless.load(loadArgs(), context);

    expect(shillerCalls).toBe(1);
    expect(result.sections.map(({ title }) => title)).toEqual([
      "Market valuation",
      "Shiller CAPE",
    ]);
    expect(result.sections[0]).toMatchObject({
      rows: [{ id: "shiller-cape", value: 39, formattedValue: "39.0", unit: "x" }],
    });
    expect(result.sections[1]).toMatchObject({ entries: expect.arrayContaining([
      { label: "Basis", value: expect.stringContaining("real earnings") },
    ]) });
    const buffett = await marketValuationHeadless.load({ ...loadArgs(), argument: "buffett" }, context);
    expect(buffett.sections[0]).toMatchObject({
      rows: [{ id: "buffett", value: 160, formattedValue: "160%", unit: "%", asOf: "2025-01-01" }],
    });
    expect(fredRequests.filter((id) => id === "FBCELLQ027S")).toHaveLength(1);
    expect(shillerCalls).toBe(1);
    expect(result.metadata).toMatchObject({ range: "10Y", selected: "shiller-cape" });
  });
});
