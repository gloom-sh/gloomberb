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

test("a coin's partial and filled days say so, its volume is labelled in its quote currency, and a missing one says why", async () => {
  // BTC-USD at 00:25 UTC on 12 Oct 2026, as Gloom Cloud flags the bars: Oct 11 rebuilt from hourly
  // bars without volume, Oct 12 still forming without the rolling 24-hour figure.
  setSystemTime(new Date("2026-10-12T00:25:00Z"));
  try {
    const cli = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async () => createTestQuote({ symbol: "BTC-USD", currency: "USD", listingExchangeName: "CCC", instrumentType: "CRYPTOCURRENCY" }),
        getPriceHistoryWithMetadata: async () => ({
          resolution: "1d",
          points: [
            { date: new Date("2026-10-10"), open: 82546.32, high: 83092.03, low: 82473.04, close: 82912.23, volume: 12485050512 },
            { date: new Date("2026-10-11"), open: 82913.3, high: 84110.54, low: 82716.81, close: 83680.59, filled: true },
            { date: new Date("2026-10-12"), open: 83673.01, high: 83704.88, low: 83652.21, close: 83704.88, partial: true },
          ],
        }),
      }),
    });
    await history.execute(["BTC-USD"], cli.context);
    const [{ result, options }] = cli.printed;
    expect(result.data.map((row: Record<string, unknown>) => [row.date, row.volume, row.volumeUnit, row.volumeNote, row.partial, row.filled])).toEqual([
      ["2026-10-10", 12485050512, "USD", undefined, undefined, undefined],
      ["2026-10-11", null, "USD", "rebuilt from hourly bars", undefined, true],
      ["2026-10-12", null, "USD", "day in progress", true, undefined],
    ]);
    expect(result.metadata).toMatchObject({ volumeUnit: "USD", volumePeriod: "UTC day" });
    expect(result.warnings).toContain(
      "2026-10-12 is still forming (partial), with no volume until the day closes; 2026-10-11 was rebuilt from hourly bars (filled), without volume",
    );
    const text = serializeCliResult(result, DEFAULT_CLI_OPTIONS, options).split("\n");
    expect(text.at(-1)).toBe("Source: Gloom Cloud \u00b7 Mon 12 Oct 2026 \u00b7 not a live feed (daily closes) \u00b7 volume in USD per UTC day");
    expect(text.find((line) => line.startsWith("2026-10-12"))).toMatch(/partial$/);
  } finally {
    setSystemTime();
  }
});

test("a stock's history keeps its export columns, with no volume unit it cannot vouch for", async () => {
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async () => createTestQuote({ symbol: "AAPL", currency: "USD", listingExchangeName: "NASDAQ", instrumentType: "EQUITY" }),
      getPriceHistoryWithMetadata: async () => ({
        resolution: "1d",
        points: [{ date: new Date("2026-10-09"), open: 340, high: 341, low: 330, close: 336.63, volume: 41_000_000 }],
      }),
    }),
  });
  await history.execute(["AAPL"], cli.context);
  const [{ result }] = cli.printed;
  expect(Object.keys(result.data[0] as object)).toEqual(["date", "open", "high", "low", "close", "volume", "currency", "unit", "interval", "flag"]);
  expect(result.metadata).not.toHaveProperty("volumeUnit");
  expect(result.freshness).not.toHaveProperty("note");
});

test("history of a listing that stopped trading says so instead of not a ticker, and a symbol whose company left says so beside its bars", async () => {
  const lastTrade = Date.parse("2022-10-27T23:59:59.953Z");
  const hop = { from: "FB", to: "META", date: "2022-06-09" };
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => symbol === "TWTR"
      ? createTestQuote({ symbol, price: 53.86, lastUpdated: lastTrade, lastTradeTime: lastTrade, stale: true })
      : createTestQuote({ symbol, name: "ProShares S&P 500 Dynamic Daily Buffer ETF", listingExchangeName: "BATS" }),
    getPriceHistoryWithMetadata: async (symbol) => {
      if (symbol === "TWTR") throw new Error("Not a ticker: TWTR.");
      return { resolution: "1d", points: [{ date: new Date("2026-10-09"), open: 45.9, high: 46, low: 45.8, close: 45.98, volume: 1042 }] };
    },
    getTickerChanges: async (symbol) => symbol === "FB"
      ? { symbol, moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [hop] }, formerly: null, listedName: null, changes: [hop] }
      : null,
  });
  const cli = createTestCliContext({ config: createDefaultConfig("/tmp/gloom-history-command-fixture"), dataProvider });
  await expect(history.execute(["TWTR", "--range", "5Y"], cli.context)).rejects.toThrow("TWTR stopped trading 2022-10-27; no history or options served.");
  await history.execute(["FB"], cli.context);
  expect(cli.printed[0]!.result.warnings?.[0]).toBe(
    "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)",
  );
});
