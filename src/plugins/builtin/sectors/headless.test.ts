import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createSectorsHeadless } from "./headless";

function args(collection: string): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: { collection } };
}

describe("sectors headless model", () => {
  test("reports incomplete quotes even when historical returns remain available", async () => {
    const headless = createSectorsHeadless({
      load: async (_args, definitions) => definitions.map((definition) => ({
        etf: definition.etf,
        row: { price: null, changePercent: null, return1Y: 10, quoteUnavailable: true },
      })),
    });
    const result = await headless.load(args("sectors"), {} as HeadlessPaneContext);
    expect(result.unavailableSymbols).toContain("XLK");
    expect(result.rows.find((row) => row.etf === "XLK")?.return1Y).toBe(10);
  });

  test("changes the loaded ETF universe with the collection option", async () => {
    const requested: string[][] = [];
    const headless = createSectorsHeadless({
      load: async (_args, definitions) => {
        requested.push(definitions.map(({ etf }) => etf));
        return definitions.map((definition, index) => ({
          etf: definition.etf,
          row: { price: 100, changePercent: index, return1M: index + 1, return1Y: index + 2, currency: "USD" },
        }));
      },
    });

    const sectors = await headless.load(args("sectors"), {} as HeadlessPaneContext);
    const industries = await headless.load(args("industries"), {} as HeadlessPaneContext);
    expect(sectors.rows.some((row) => row.etf === "XLK")).toBe(true);
    expect(industries.rows.some((row) => row.etf === "SMH")).toBe(true);
    expect(requested[0]).not.toEqual(requested[1]);
  });
});
