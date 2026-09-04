import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createMarketMoversHeadless } from "./headless";

function args(list: string): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: { list } };
}

describe("market movers headless model", () => {
  test("loads the selected list and computes each quote's 52-week position", async () => {
    const loaded: string[] = [];
    const headless = createMarketMoversHeadless({
      load: async (_args, tab) => {
        loaded.push(tab);
        return {
          tab,
          source: "cloud",
          stale: false,
          quotes: [{
            symbol: "NVDA", name: "NVIDIA", price: 150, change: 5, changePercent: 3.4,
            volume: 100, avgVolume: 50, volumeRatio: 2, marketCap: 1_000,
            currency: "USD", fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 100,
            dayHigh: 151, dayLow: 142, exchange: "NASDAQ",
          }],
        };
      },
    });

    const gainers = await headless.load(args("gainers"), {} as HeadlessPaneContext);
    await headless.load(args("actives"), {} as HeadlessPaneContext);
    expect(loaded).toEqual(["gainers", "actives"]);
    expect(gainers.rows).toEqual([expect.objectContaining({ rank: 1, rangePositionPercent: 50 })]);
  });
});
