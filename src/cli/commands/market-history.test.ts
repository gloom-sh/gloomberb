import { expect, setSystemTime, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";
import type { PriceHistoryResult } from "../../types/price-history";

const history = marketDataCliCommands.find((command) => command.name === "history")!;

test("history CSV keeps the price columns first, every row ends with its flag, what it is a bar of, its currency, interval and source, and it ends with its source", async () => {
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
    "Date,Open,High,Low,Close,Volume,Flag,symbol_or_series,currency_or_unit,interval,source,as_of",
    "2025-10-09,,,,,,low>open,SBK.JO,ZAR,1d,Gloom Cloud,2025-10-10",
    "2025-10-10,249,258.15,249,256,4093192,,SBK.JO,ZAR,1d,Gloom Cloud,2025-10-10",
    "",
  ]);
  expect(lines.slice(4).map((line) => line.split(":")[0])).toEqual(["# Source", "# Publisher", "# Observation date", "# Publication time", "# Retrieval time"]);
  expect(result.warnings).toEqual(["1 of 2 bars has low above open or close in the source data; their prices are left blank"]);
  expect(result.metadata).toMatchObject({
    currency: "ZAR", unit: "ZAR", interval: "1d", requestedRange: "1Y", firstDate: "2025-10-09", lastDate: "2025-10-10", bars: 2,
  });
});

test("YTD, in any case, starts at the prior year's last close: LMT from 31 Dec, never the year's first session", async () => {
  setSystemTime(new Date("2026-10-17T12:00:00Z"));
  try {
    const ranges: string[] = [];
    const bar = (date: string, close: number) => ({ date: new Date(date), open: close, high: close, low: close, close, volume: 1000 });
    const cli = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async () => createTestQuote({ symbol: "LMT", currency: "USD" }),
        getPriceHistoryWithMetadata: async (_symbol, _exchange, range) => {
          ranges.push(range);
          return { resolution: "1d", points: [bar("2025-12-30", 488), bar("2025-12-31", 483.67), bar("2026-01-02", 497.07), bar("2026-10-16", 548.23)] };
        },
      }),
    }, { format: "csv" });
    await history.execute(["LMT", "--range", "ytd"], cli.context);
    const [{ result }] = cli.printed;
    expect(ranges).toEqual(["1Y"]);
    expect((result.data as Array<{ date: string; close: number }>).map((row) => [row.date, row.close])).toEqual([
      ["2025-12-31", 483.67], ["2026-01-02", 497.07], ["2026-10-16", 548.23],
    ]);
    expect(result.metadata).toMatchObject({ requestedRange: "YTD", firstDate: "2025-12-31", bars: 3 });
    expect(result.warnings?.filter((warning) => warning.startsWith("Asked"))).toEqual([]);
  } finally {
    setSystemTime();
  }
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

test("history shows today's session from the quote in every range, partial, whether the source's copy has a snapshot of it or none", async () => {
  // Fri 16 Oct 2026, 15:14 in New York. Gloom Cloud's 3M copy holds a snapshot of the opening minutes; its 1M copy has no bar for today.
  setSystemTime(new Date("2026-10-16T19:14:30Z"));
  try {
    const finished = [
      { date: new Date("2026-10-14"), open: 344.61, high: 347.09, low: 341.72, close: 342.96, volume: 50_061_100 },
      { date: new Date("2026-10-15"), open: 346.95, high: 347.85, low: 341.6, close: 342, volume: 39_678_300 },
    ];
    const snapshot = { date: new Date("2026-10-16"), open: 346.085, high: 347.8, low: 341.12, close: 341.995, volume: 1_096_219 };
    const run = async (points: typeof finished, quote = {}) => {
      const cli = createTestCliContext({
        config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
        dataProvider: createTestDataProvider({
          getQuote: async () => createTestQuote({
            symbol: "AAPL", price: 340.91, previousClose: 342, open: 346.085, high: 347.82, low: 340.46, volume: 39_269_651, marketState: "REGULAR",
            changeSessionDate: "2026-10-16", listingExchangeName: "NASDAQ", instrumentType: "Common Stock", lastUpdated: Date.now() - 15 * 60_000, ...quote,
          }),
          getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points }),
        }),
      });
      await history.execute(["AAPL", "--range", "3M"], cli.context);
      const [{ result, options }] = cli.printed;
      return { result, text: serializeCliResult(result, DEFAULT_CLI_OPTIONS, options).split("\n") };
    };
    for (const points of [[...finished, snapshot], finished]) {
      const { result, text } = await run(points);
      expect(result.data.at(-1)).toMatchObject({ date: "2026-10-16", open: 346.085, high: 347.82, low: 340.46, close: 340.91, volume: 39_269_651, partial: true });
      expect(result.data.slice(0, -1).some((row: Record<string, unknown>) => row.partial)).toBe(false);
      expect(result.warnings).toContain("2026-10-16 is still forming (partial)");
      expect(text.find((line) => line.startsWith("2026-10-16"))).toMatch(/partial$/);
      expect(text.find((line) => line.startsWith("Source:"))).toContain("(daily bars) \u00b7 the newest bar is today so far");
      expect(result.freshness).toMatchObject({ basis: "daily bars", asOf: "2026-10-16T18:59:30.000Z" });
    }
    // Without a current quote the snapshot is not today's row, and a source with no bar for today shows none.
    for (const points of [[...finished, snapshot], finished]) {
      const { result } = await run(points, { stale: true });
      expect(result.data.map((row: Record<string, unknown>) => row.date)).toEqual(["2026-10-14", "2026-10-15"]);
    }
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

test("a break in the series is flagged on the bar after it in every export, and a series served from after it has none", async () => {
  // USDILS=X monthly as the source served it: 34 old-shekel bars, 148 months without one, then new shekels.
  const old = Array.from({ length: 34 }, (_, month) => ({
    date: new Date(Date.UTC(1977, 9 + month, 1)), close: Number((0.0015 + month * 0.0034 / 33).toFixed(4)),
  }));
  const shekels = [2.763, 2.762].map((close, month) => ({ date: new Date(Date.UTC(1992, 11 + month, 1)), close }));
  setSystemTime(new Date("2026-10-21T12:00:00Z"));
  const run = async (format: "json" | "csv" | "text", served: Omit<PriceHistoryResult, "resolution">) => {
    const cli = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async () => createTestQuote({ symbol: "USDILS=X", currency: "ILS", instrumentType: "CURRENCY" }),
        getPriceHistoryWithMetadata: async () => ({ resolution: "1mo", ...served }),
      }),
    }, { format });
    await history.execute(["USDILS=X", "--range", "ALL"], cli.context);
    const [{ result, options }] = cli.printed;
    return { result, text: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format }, options) };
  };
  // ALL reaches back to 1976-10; the source's first bar is from a year later.
  const warnings = ["ALL starts 1977-10; the source has no earlier bar", "No bars for 1980-08 to 1992-11 (148 months)",
    "Close rises 564x from 0.0049 on 1980-07-01 to 2.763 on 1992-12-01"];
  try {
    const json = JSON.parse((await run("json", { points: [...old, ...shekels] })).text);
    expect(json.warnings).toEqual(warnings);
    expect(json.metadata).toMatchObject({ firstDate: "1977-10-01", unbrokenFrom: "1992-12-01", bars: 36 });
    expect(json.data[34]).toMatchObject({ date: "1992-12-01", close: 2.763, flag: "gap,jump" });
    const csv = await run("csv", { points: [...old, ...shekels] });
    expect(csv.result.warnings).toEqual(warnings);
    // Dated by the January bar's last session, not the day it opens.
    expect(csv.text.split("\n").filter((line) => /gap|jump/.test(line))).toEqual(["1992-12-01,,,,2.763,,\"gap,jump\",USDILS=X,ILS,1mo,Gloom Cloud,1993-01-29"]);
    const text = await run("text", { points: [...old, ...shekels] });
    expect(text.text).toContain("ILS per USD  \u00b7  monthly bars  \u00b7  1977-10-01 to 1993-01-01  \u00b7  36 bars  \u00b7  unbroken from 1992-12-01");
    // Gloom Cloud clips the pair at the new shekel and says why; the bars it serves have no break.
    const clipped = JSON.parse((await run("json", {
      points: shekels, coverageStart: "1992-12-01", coverageNote: "old-shekel quotes before 1992 are not served",
    })).text);
    expect(clipped.warnings).toEqual(["Price history starts 1992-12-01; old-shekel quotes before 1992 are not served."]);
    expect(clipped.metadata.unbrokenFrom).toBe("1992-12-01");
    expect(clipped.data.map((row: { flag: string | null }) => row.flag)).toEqual([null, null]);
  } finally {
    setSystemTime();
  }
});

test("a past window reads its own dates' bars, in the size its span takes, with no bar from today's quote and no feed to go stale", async () => {
  // Thursday 22 Oct 2026 while New York trades: a range would end with the session's bar.
  setSystemTime(new Date("2026-10-22T15:00:00Z"));
  try {
    const asked: string[] = [];
    const bar = (date: string, close: number) => ({ date: new Date(`${date}T00:00:00Z`), open: close, high: close, low: close, close, volume: 1000 });
    const run = async (args: string[]) => {
      const cli = createTestCliContext({
        config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
        dataProvider: createTestDataProvider({
          getQuote: async () => createTestQuote({ symbol: "JPM", currency: "USD", listingExchangeName: "NYSE", price: 300 }),
          getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, start, end, interval) => {
            asked.push(`${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} in ${interval}`);
            return interval === "1mo"
              ? { resolution: "1mo", points: [bar("1990-08-01", 5), bar("1990-09-01", 5.2), bar("1990-10-01", 3.4), bar("2020-12-01", 117.8)] }
              : { resolution: "1d", points: [bar("2006-12-29", 48), bar("2007-05-09", 53.2), bar("2009-03-09", 15.9), bar("2009-12-31", 41.67)] };
          },
        }),
      }, { format: "json" });
      await history.execute(args, cli.context);
      return cli.printed[0]!.result;
    };

    const crisis = await run(["JPM", "--from", "2007", "--to", "2009"]);
    expect((crisis.data as Array<{ date: string }>).map((row) => row.date)).toEqual(["2007-05-09", "2009-03-09", "2009-12-31"]);
    expect(crisis.metadata).toMatchObject({
      requestedWindow: { from: "2007-01-01", to: "2009-12-31" }, requestedRange: null, interval: "1d",
      maxDrawdown: { peak: { date: "2007-05-09", close: 53.2 }, trough: { date: "2009-03-09", close: 15.9 }, recovered: null },
    });
    expect(crisis.freshness).toMatchObject({ status: "not-a-feed", basis: "daily bars, 2007 to 2009" });

    // Thirty years come in monthly bars, from the month --from falls in, with no word of data starting late.
    const long = await run(["JPM", "--from", "1990-09-15", "--to", "2020"]);
    expect((long.data as Array<{ date: string }>).map((row) => row.date)).toEqual(["1990-09-01", "1990-10-01", "2020-12-01"]);
    expect(long.warnings?.filter((warning) => warning.startsWith("Asked")) ?? []).toEqual([]);
    expect(asked).toEqual(["2007-01-01 to 2009-12-31 in 1d", "1990-09-01 to 2020-12-31 in 1mo"]);

    await expect(run(["JPM", "--range", "5Y", "--from", "2007"])).rejects.toThrow("--from replaces --range; give one of them.");
    await expect(run(["JPM", "--to", "2009"])).rejects.toThrow("--to needs a --from: --from 2007 --to 2009.");
    expect(asked).toHaveLength(2);
  } finally {
    setSystemTime();
  }
});

test("history reads a Bloomberg code as its listing: VOD LN Equity is Vodafone in London", async () => {
  const asked: string[] = [];
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async () => createTestQuote({ symbol: "VOD", currency: "GBP" }),
      getPriceHistoryWithMetadata: async (symbol, exchange) => {
        asked.push(`${symbol}@${exchange}`);
        return { resolution: "1d", points: [{ date: new Date("2026-10-16"), open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 1000 }] };
      },
    }),
  }, { format: "json" });
  await history.execute(["VOD LN Equity"], cli.context);
  expect(asked).toEqual(["VOD:LSE@LSE"]);
  expect(cli.printed[0]!.result.warnings).toContain('Read "VOD LN Equity" as VOD:LSE.');
});
