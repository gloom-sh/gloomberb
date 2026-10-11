import { expect, setSystemTime, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

const history = marketDataCliCommands.find((command) => command.name === "history")!;

test("history CSV keeps the price columns first, every row says its currency, unit, interval and flag, and it ends with its source", async () => {
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async () => createTestQuote({ symbol: "SBK.JO", currency: "ZAR" }),
      getPriceHistoryWithMetadata: async () => ({
        resolution: "1d",
        points: [
          { date: new Date("2025-10-09"), open: 245.86, high: 253.3, low: 246.23, close: 252.46, volume: 3018311 },
          { date: new Date("2025-10-10"), open: 249, high: 258.15, low: 249, close: 256, volume: 4093192 },
        ],
      }),
    }),
  }, { format: "csv" });
  await history.execute(["SBK.JO", "--range", "1Y"], cli.context);
  const [{ result, options }] = cli.printed;
  const lines = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
  expect(lines.slice(0, 4)).toEqual([
    "Date,Open,High,Low,Close,Volume,Currency,Unit,Interval,Flag",
    "2025-10-09,,,,,,ZAR,ZAR,1d,low>open",
    "2025-10-10,249,258.15,249,256,4093192,ZAR,ZAR,1d,",
    "",
  ]);
  expect(lines.slice(4).map((line) => line.split(":")[0])).toEqual(["# Source", "# Publisher", "# Observation date", "# Publication time", "# Retrieval time"]);
  expect(result.warnings).toEqual(["1 of 2 bars has low above open or close in the source data; their prices are left blank"]);
  expect(result.metadata).toMatchObject({
    currency: "ZAR", unit: "ZAR", interval: "1d", requestedRange: "1Y", firstDate: "2025-10-09", lastDate: "2025-10-10", bars: 2,
  });
});

test("a venue's daily bars are dated by its own trading days, not New York's", async () => {
  // Saturday 10 Oct 2026: EGX last traded Wednesday (Thursday was a holiday,
  // its week ends Thursday); New York traded Thursday and Friday since.
  setSystemTime(new Date("2026-10-10T21:40:00Z"));
  try {
    const cli = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async () => createTestQuote({ symbol: "COMI.CA", currency: "EGP", listingExchangeName: "EGX" }),
        getPriceHistoryWithMetadata: async () => ({
          resolution: "1d",
          points: [{ date: new Date("2026-10-07"), open: 125.16, high: 125.9, low: 124.14, close: 124.65, volume: 3345837 }],
        }),
      }),
    });
    await history.execute(["COMI.CA", "--range", "1D"], cli.context);
    const [{ result }] = cli.printed;
    expect(result.warnings).toEqual(["Asked 1D, got daily bars from 2026-10-07"]);
    expect(result.freshness).toMatchObject({ status: "not-a-feed" });
  } finally {
    setSystemTime();
  }
});
