import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { statsCache } from "./cache";
import { econStatisticsHeadless } from "./headless";

beforeEach(() => statsCache.reset());
afterEach(() => statsCache.reset());

function monthlyCpi() {
  return Array.from({ length: 25 }, (_, index) => {
    const year = 2024 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return {
      date: `${year}-${String(month).padStart(2, "0")}-01`,
      value: 300 + index,
    };
  });
}

const args: HeadlessPaneLoadArgs = {
  rawArgument: "cpi",
  argument: "cpi",
  symbols: [],
  options: { range: "5Y" },
};

describe("economic statistics headless model", () => {
  test("loads through the injected cloud client and produces category sections", async () => {
    const requested: string[] = [];
    const apiClient = {
      getCloudFredSeries: async (seriesId: string) => {
        requested.push(seriesId);
        return { seriesId, observations: monthlyCpi() };
      },
    } as unknown as HeadlessPaneContext["apiClient"];
    const context: HeadlessPaneContext = {
      marketData: createTestDataProvider(),
      apiClient,
      config: createDefaultConfig("/tmp/gloomberb-headless-econ"),
      signal: new AbortController().signal,
    };

    const result = await econStatisticsHeadless.load(args, context);

    expect(requested).toEqual(["CPIAUCSL"]);
    expect(result.sections.map(({ title }) => title)).toEqual(["Inflation", "CPI"]);
    expect(result.sections[0]).toMatchObject({
      rows: [{ id: "cpi-yoy", indicator: "CPI y/y" }],
    });
    expect(result.metadata).toMatchObject({ range: "5Y", selected: "cpi-yoy" });
  });
});
