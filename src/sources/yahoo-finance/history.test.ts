import { describe, expect, test } from "bun:test";
import { loadYahooPriceHistoryForResolution } from "./history";

describe("Yahoo chart history", () => {
  test("repairs an isolated intraday wick without dropping the bar", async () => {
    const history = await loadYahooPriceHistoryForResolution({
      ticker: "AMD",
      exchange: "NASDAQ",
      bufferRange: "1M",
      resolution: "15m",
      fetchChart: async () => ({
        meta: { currency: "USD" },
        history: [
          {
            date: new Date("2026-07-06T14:00:00.000Z"),
            open: 99.5,
            high: 101,
            low: 99,
            close: 100,
          },
          {
            date: new Date("2026-07-06T14:15:00.000Z"),
            open: 100,
            high: 150,
            low: 99,
            close: 100.5,
          },
          {
            date: new Date("2026-07-06T14:30:00.000Z"),
            open: 100.5,
            high: 101,
            low: 100,
            close: 100.7,
          },
        ],
      }),
    });

    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({
      open: 100,
      high: 100.5,
      low: 99,
      close: 100.5,
    });
  });
});
