import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";

const history = marketDataCliCommands.find((command) => command.name === "history")!;

test("history CSV keeps the price columns first and every row says its currency, interval and flag", async () => {
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
  expect(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n")).toEqual([
    "Date,Open,High,Low,Close,Volume,Currency,Interval,Flag",
    "2025-10-09,,,,,,ZAR,1d,low>open",
    "2025-10-10,249,258.15,249,256,4093192,ZAR,1d,",
  ]);
  expect(result.warnings).toEqual(["1 of 2 bars has low above open or close in the source data; their prices are left blank"]);
  expect(result.metadata).toMatchObject({
    currency: "ZAR", unit: "ZAR", interval: "1d", requestedRange: "1Y", firstDate: "2025-10-09", lastDate: "2025-10-10", bars: 2,
  });
});
