import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createWorldIndicesHeadless } from "./headless";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

describe("world indices headless model", () => {
  test("groups quote rows by the same world regions as the pane", async () => {
    const headless = createWorldIndicesHeadless({
      load: async (_args, entries) => ({
        quotes: new Map(entries.map((entry) => [entry.symbol, {
          symbol: entry.symbol,
          price: entry.symbol === "^GSPC" ? 6_800 : 100,
          currency: "USD",
          change: 10,
          changePercent: 0.5,
          lastUpdated: 1_700_000_000_000,
          marketState: "REGULAR" as const,
        }])),
        errors: [],
      }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.sections.map((section) => section.title)).toEqual([
      "Americas", "Europe", "Asia-Pacific", "Other",
    ]);
    expect(result.sections[0]?.rows?.[0]).toMatchObject({
      symbol: "^GSPC", shortName: "SPX", price: 6_800,
    });
  });
});
