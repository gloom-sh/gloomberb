import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { collectSavedCopies, servedFromSavedCopy } from "../../data/saved-copies";
import { createDefaultConfig } from "../../types/config";
import { createTestDataProvider, createTestQuote, fallbackProvider } from "../../test-support/data-provider";
import { createTestCliContext } from "../../test-support/cli-context";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { fail, isCliFailure, printCliError } from "../errors";
import { AssetDataRouter } from "../../sources/provider-router";
import { captureConsole } from "../../test-support/console";
import { serializeCliResult } from "../result";
import { marketDataCliCommands } from "./market";
import type { PriceHistoryResult } from "../../types/price-history";

const history = marketDataCliCommands.find((command) => command.name === "history")!;

afterEach(() => { process.exitCode = 0; });

/** Every history export's own columns, whatever the symbol or the market's state. */
const HISTORY_CSV_HEADER = "Date,Open,High,Low,Close,Volume,Flag,Partial,Filled,Unsettled,Volume unit,Volume note,Venue volume,Volume venue,Volume basis,status";

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
    `${HISTORY_CSV_HEADER},symbol_or_series,currency_or_unit,interval,source,as_of`,
    "2025-10-09,,,,,,low>open,false,false,false,,,,,,prices left blank: low>open,SBK.JO,ZAR,1d,Gloom Cloud,2025-10-10",
    "2025-10-10,249,258.15,249,256,4093192,,false,false,false,,,,,,,SBK.JO,ZAR,1d,Gloom Cloud,2025-10-10",
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
    // Signed out or free, the day so far is read from the delayed quote, and the status line says how late, not "not a live feed".
    const delayed = await run([...finished, snapshot], { dataSource: "delayed" });
    expect(delayed.result.freshness).toMatchObject({ status: "delayed", delayMinutes: 15 });
    expect(delayed.text.find((line) => line.startsWith("Source:"))).toContain("15 min delayed");
    expect(delayed.text.find((line) => line.startsWith("Source:"))).not.toContain("not a live feed");
    // Without a current quote the snapshot is not today's row, and a source with no bar for today shows none.
    for (const points of [[...finished, snapshot], finished]) {
      const { result } = await run(points, { stale: true });
      expect(result.data.map((row: Record<string, unknown>) => row.date)).toEqual(["2026-10-14", "2026-10-15"]);
    }
  } finally {
    setSystemTime();
  }
});

test("a day the data service still marks partial after its session closed is exported partial and said to wait for its bar", async () => {
  // GGAL on BYMA, Sat 24 Oct 2026: Friday closed at 6,260 on the quote while its daily bar was not final yet.
  setSystemTime(new Date("2026-10-24T14:00:00Z"));
  try {
    const cli = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async () => createTestQuote({ symbol: "GGAL", currency: "ARS", price: 6260, listingExchangeName: "BYMA",
          marketState: "CLOSED", changeSessionDate: "2026-10-23", instrumentType: "EQUITY" }),
        getPriceHistoryWithMetadata: async () => ({
          resolution: "1d",
          points: [
            { date: new Date("2026-10-22"), open: 5960, high: 5970, low: 5825, close: 5900, volume: 2_745_809 },
            { date: new Date("2026-10-23"), open: 5965, high: 6280, low: 5910, close: 6260, volume: 2_472_150, partial: true },
          ],
        }),
      }),
    }, { format: "csv" });
    await history.execute(["GGAL:BYMA"], cli.context);
    const [{ result, options }] = cli.printed;
    expect(result.warnings).toContain("2026-10-23 closes on the session's last price until the day's bar is final (partial)");
    const [header, , friday] = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
    const partial = header!.split(",").indexOf("Partial");
    expect(partial).toBeGreaterThan(0);
    expect(friday!.split(",")[partial]).toBe("true");
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
    "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; FB was Meta Platforms before, now META (changed 2022-06-09)",
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
    expect(csv.text.split("\n").filter((line) => /gap|jump/.test(line))).toEqual(["1992-12-01,,,,2.763,,\"gap,jump\",false,false,false,,,,,,,USDILS=X,ILS per USD,1mo,Gloom Cloud,1993-01-29"]);
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

/**
 * At 08:12Z on 30 Oct 2026 `history BTC-USD --from 2025-10-31` printed "0 bars · No results" (`ok: true`, no rows)
 * while `--range 1Y` failed with "No source could load history for BTC-USD just now".
 */
test("a window of dates no source could load is a retryable failure, never an empty history; a source with nothing keeps its empty answer", async () => {
  const run = async (getDetailedPriceHistory: () => Promise<PriceHistoryResult["points"]>) => {
    const provider = { ...fallbackProvider, id: "window-failure", getQuote: async () => createTestQuote({ symbol: "BTC-USD", currency: "USD" }), getDetailedPriceHistory };
    const cli = createTestCliContext({ config: createDefaultConfig("/tmp/gloom-history-command-fixture"), dataProvider: new AssetDataRouter(provider) }, { format: "json" });
    return history.execute(["BTC-USD", "--from", "2025-10-31"], cli.context).then(() => cli.printed[0]!.result);
  };
  const failure = await run(async () => { throw new Error("Request timed out"); }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("No source could load history for BTC-USD just now");
  const printed = await captureConsole(() => printCliError(failure, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(JSON.parse(printed.stderr)).toMatchObject({ ok: false, error: { code: "source_unavailable", retryable: true } });
  // A source that answered with no bars in the window is no failure.
  expect(await run(async () => []).catch((error: unknown) => error)).not.toBeInstanceOf(Error);
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

// 244 symbols were 244 calls and as many files whose headers changed with the market's state.
test("history of several symbols is one long table with the single-symbol header, each row naming its symbol and currency, a symbol with none a row with its reason", async () => {
  // Fri 23 Oct 2026, 15:00 UTC: Nasdaq trades, so AAPL's day is a partial bar; KRX has closed.
  setSystemTime(new Date("2026-10-23T15:00:00Z"));
  const bar = (date: string, close: number) => ({ date: new Date(date), open: close, high: close, low: close, close, volume: 1000 });
  const quotes: Record<string, ReturnType<typeof createTestQuote>> = {
    AAPL: createTestQuote({ symbol: "AAPL", currency: "USD", listingExchangeName: "NASDAQ", instrumentType: "Common Stock", marketState: "REGULAR",
      price: 347.79, previousClose: 348.22, open: 349.12, high: 351.73, low: 347.26, volume: 9_050_207, changeSessionDate: "2026-10-23",
      lastUpdated: Date.parse("2026-10-23T14:45:00Z") }),
    "000660.KS": createTestQuote({ symbol: "000660.KS", currency: "KRW", listingExchangeName: "KRX", marketState: "CLOSED", price: 1_277_000,
      lastUpdated: Date.parse("2026-10-23T06:30:00Z") }),
  };
  const windows: Array<[string, string]> = [];
  try {
    const cli = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async (symbol) => {
          if (!quotes[symbol]) throw new Error(`Not a ticker: ${symbol}.`);
          return quotes[symbol]!;
        },
        getDetailedPriceHistoryWithMetadata: async (symbol, _exchange, start, end) => {
          if (symbol === "ENDED") return { resolution: "1d", points: [] };
          if (!quotes[symbol]) throw new Error(`Not a ticker: ${symbol}.`);
          windows.push([start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
          return { resolution: "1d", points: symbol === "AAPL" ? [bar("2026-10-21", 344.5), bar("2026-10-22", 348.22)] : [bar("2026-10-22", 1_223_000), bar("2026-10-23", 1_277_000)] };
        },
      }),
    }, { format: "csv" });
    await history.execute(["AAPL", "000660.KS", "ZZZZQQ", "ENDED", "--start", "2026-10-21", "--end", "2026-10-23"], cli.context);
    const [{ result, options }] = cli.printed;
    expect(windows).toEqual([["2026-10-21", "2026-10-23"], ["2026-10-21", "2026-10-23"]]);
    const lines = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
    expect(lines.slice(0, 9)).toEqual([
      `${HISTORY_CSV_HEADER},symbol_or_series,currency_or_unit,interval,source,as_of`,
      "2026-10-21,344.5,344.5,344.5,344.5,1000,,false,false,false,,,,,,,AAPL,USD,1d,Gloom Cloud,2026-10-23T14:45:00.000Z",
      "2026-10-22,348.22,348.22,348.22,348.22,1000,,false,false,false,,,,,,,AAPL,USD,1d,Gloom Cloud,2026-10-23T14:45:00.000Z",
      "2026-10-23,349.12,351.73,347.26,347.79,9050207,,true,false,false,,,,,,,AAPL,USD,1d,Gloom Cloud,2026-10-23T14:45:00.000Z",
      "2026-10-22,1223000,1223000,1223000,1223000,1000,,false,false,false,,,,,,,000660.KS,KRW,1d,Gloom Cloud,2026-10-23",
      "2026-10-23,1277000,1277000,1277000,1277000,1000,,false,false,false,,,,,,,000660.KS,KRW,1d,Gloom Cloud,2026-10-23",
      ",,,,,,,,,,,,,,,Not a ticker: ZZZZQQ.,ZZZZQQ,,,Gloom Cloud,",
      // A window the source has no bar in is a row with its reason too, never left out.
      ",,,,,,,,,,,,,,,No bars for ENDED from 2026-10-21 to today.,ENDED,,,Gloom Cloud,",
      "",
    ]);
    expect(result.warnings).toEqual(expect.arrayContaining(["Not a ticker: ZZZZQQ.", "No bars for ENDED from 2026-10-21 to today."]));
    expect(result.failure).toBeUndefined();
    // One symbol alone writes the same header in the same market state.
    const single = createTestCliContext({
      config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
      dataProvider: createTestDataProvider({
        getQuote: async () => quotes["000660.KS"]!,
        getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: [bar("2026-10-23", 1_277_000)] }),
      }),
    }, { format: "csv" });
    await history.execute(["000660.KS"], single.context);
    const [printed] = single.printed;
    expect(serializeCliResult(printed!.result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, printed!.options).split("\n")[0]).toBe(lines[0]);
  } finally {
    setSystemTime();
  }
});

/** A history run of `args` against a source whose bars are `bars(symbol)`; a symbol it throws for is not a ticker. */
async function runList(args: string[], bars: (symbol: string) => Promise<PriceHistoryResult["points"]>, format: "csv" | "json" = "csv") {
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => {
        await bars(symbol);
        return createTestQuote({ symbol, currency: "USD", marketState: "CLOSED" });
      },
      getPriceHistoryWithMetadata: async (symbol) => ({ resolution: "1d", points: await bars(symbol) }),
    }),
  }, { format });
  await history.execute(args, cli.context);
  const [{ result, options }] = cli.printed;
  const csv = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n\n")[0]!.split("\n");
  const column = csv[0]!.split(",").indexOf("symbol_or_series");
  return { result, csv, symbols: csv.slice(1).map((line) => line.split(",")[column]) };
}

const dailyBar = (close: number) => [{ date: new Date("2026-10-16"), open: close, high: close, low: close, close, volume: 1000 }];
const notATicker = (symbol: string) => Promise.reject(new Error(`Not a ticker: ${symbol}.`));

test("history --wide sets several pairs side by side: a row a date, a close column a symbol headed with its unit", async () => {
  const bars: Record<string, Array<[string, number]>> = {
    "USDJPY=X": [["2026-10-29", 157.68921], ["2026-10-30", 157.58847]],
    "USDCHF=X": [["2026-10-29", 0.82431], ["2026-10-30", 0.82503]],
    // A day one series has no bar for stays blank in its column.
    "EURCHF=X": [["2026-10-30", 0.92074]],
  };
  const { csv, result } = await runList(["USDJPY=X", "USDCHF=X", "EURCHF=X", "--wide"], async (symbol) =>
    bars[symbol]!.map(([date, close]) => ({ date: new Date(date), open: close, high: close, low: close, close })));
  expect(csv).toEqual([
    "Date,USDJPY=X close (JPY per USD),USDCHF=X close (CHF per USD),EURCHF=X close (CHF per EUR),symbol_or_series,currency_or_unit,interval,source,as_of",
    "2026-10-29,157.68921,0.82431,,,,1d,Gloom Cloud,2026-10-30",
    "2026-10-30,157.58847,0.82503,0.92074,,,1d,Gloom Cloud,2026-10-30",
  ]);
  expect(result.failure).toBeUndefined();
});

test("a currency's name is its pair: history swiss franc and history yen name fx and the pair, and one word is a ticker first", async () => {
  const asked: string[] = [];
  const dataProvider = createTestDataProvider({
    getQuote: async (symbol) => {
      asked.push(symbol);
      return createTestQuote({ symbol, name: "The RealReal, Inc.", listingExchangeName: "NASDAQ" });
    },
    getPriceHistoryWithMetadata: async (symbol) => {
      if (symbol === "YEN") throw new Error("No history provider available for YEN");
      return { resolution: "1d", points: dailyBar(11.96) };
    },
  });
  const cli = createTestCliContext({ config: createDefaultConfig("/tmp/gloom-history-command-fixture"), dataProvider });
  cli.context.fail = fail;
  const failure = (args: string[]) => history.execute(args, cli.context).then(() => null, (error: unknown) => error);
  // Before: SWISS read as a Copenhagen listing and FRANC as "Not a ticker".
  expect(await failure(["swiss", "franc"])).toMatchObject({
    message: "swiss franc is a currency (CHF), not a ticker.", details: "Its rate: gloom fx CHF\nIts pair: gloom history USDCHF=X",
  });
  expect(asked).toEqual([]);
  expect(await failure(["yen"])).toMatchObject({
    message: "yen is a currency (JPY), not a ticker.", details: "Its rate: gloom fx JPY\nIts pair: gloom history USDJPY=X",
  });
  // REAL is The RealReal before it is the Brazilian real.
  await history.execute(["real"], cli.context);
  expect(cli.printed.at(-1)!.result.data).toHaveLength(1);
});

test("history of a list exits 1 only when no symbol is served, with every symbol's reason as a row", async () => {
  const { result, csv } = await runList(["ZZZZQQ", "QQQQZZ"], notATicker);
  expect(process.exitCode).toBe(1);
  expect(result.failure).toMatchObject({ message: "No history for ZZZZQQ, QQQQZZ." });
  expect(csv).toEqual([
    `${HISTORY_CSV_HEADER},symbol_or_series,currency_or_unit,interval,source,as_of`,
    ",,,,,,,,,,,,,,,Not a ticker: ZZZZQQ.,ZZZZQQ,,,Gloom Cloud,",
    ",,,,,,,,,,,,,,,Not a ticker: QQQQZZ.,QQQQZZ,,,Gloom Cloud,",
  ]);
  // One served symbol is a result, whatever the others did.
  process.exitCode = 0;
  const mixed = await runList(["AAPL", "ZZZZQQ"], (symbol) => symbol === "AAPL" ? Promise.resolve(dailyBar(348.22)) : notATicker(symbol));
  expect(process.exitCode).toBe(0);
  expect(mixed.result.failure).toBeUndefined();
  expect(mixed.symbols).toEqual(["AAPL", "ZZZZQQ"]);
});

test("history reads a list from --file (a text file, or a CSV's first column) and from standard input with -", async () => {
  const bars = async () => dailyBar(10);
  const dir = await mkdtemp(join(tmpdir(), "gloomberb-history-file-"));
  const stdin = spyOn(Bun.stdin, "text").mockResolvedValue("MSFT\nNVDA\n");
  try {
    const text = join(dir, "symbols.txt");
    await Bun.write(text, "AAPL\n000660.KS\n");
    expect((await runList(["--file", text, "--range", "1M"], bars)).symbols).toEqual(["AAPL", "000660.KS"]);
    const sheet = join(dir, "holdings.csv");
    await Bun.write(sheet, "Symbol,Shares\nAAPL,10\nMSFT,5\n");
    expect((await runList(["--file", sheet, "--range", "1M"], bars)).symbols).toEqual(["AAPL", "MSFT"]);
    // Standard input is read only when asked for.
    expect((await runList(["-", "--range", "1M"], bars)).symbols).toEqual(["MSFT", "NVDA"]);
    expect(stdin).toHaveBeenCalledTimes(1);
    // A file with no symbol in it says so and fails, however the list was meant.
    const empty = join(dir, "empty.txt");
    await Bun.write(empty, "\n");
    await expect(runList(["--file", empty], bars)).rejects.toThrow(`No symbols in ${empty}.`);
  } finally {
    stdin.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history names the date options as typed: --start and --from together, --end alone, and either beside --range", async () => {
  const bars = async () => dailyBar(10);
  await expect(runList(["AAPL", "--start", "2020", "--from", "2021"], bars)).rejects.toThrow("--start is --from; give one of them.");
  await expect(runList(["AAPL", "--end", "2024", "--to", "2025"], bars)).rejects.toThrow("--end is --to; give one of them.");
  await expect(runList(["AAPL", "--end", "2024"], bars)).rejects.toThrow("--end needs a --start: --start 2022 --end 2024.");
  await expect(runList(["AAPL", "--to", "2024"], bars)).rejects.toThrow("--to needs a --from: --from 2022 --to 2024.");
  await expect(runList(["AAPL", "--start", "2024-13-01"], bars)).rejects.toThrow('Invalid --start "2024-13-01".');
  await expect(runList(["AAPL", "--start", "2024", "--range", "1M"], bars)).rejects.toThrow("--start replaces --range; give one of them.");
  await expect(runList(["AAPL", "--from", "2024", "--range", "1M"], bars)).rejects.toThrow("--from replaces --range; give one of them.");
  // A list reads them the same way.
  await expect(runList(["AAPL", "MSFT", "--start", "2024", "--range", "1M"], bars)).rejects.toThrow("--start replaces --range; give one of them.");
});

test("a list of more than 8 symbols loads 8 at a time and writes them in the order given", async () => {
  const symbols = Array.from({ length: 21 }, (_, index) => `S${String(index).padStart(2, "0")}`);
  // A symbol's quote and its bars are asked for together: count the symbols in flight, not the calls.
  const asking = new Map<string, number>();
  let peak = 0;
  const { symbols: written } = await runList(symbols, async (symbol) => {
    asking.set(symbol, (asking.get(symbol) ?? 0) + 1);
    peak = Math.max(peak, [...asking.values()].filter((count) => count > 0).length);
    await new Promise((resolve) => setTimeout(resolve, 5));
    asking.set(symbol, asking.get(symbol)! - 1);
    return dailyBar(10);
  });
  expect(written).toEqual(symbols);
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(8);
});

test("a list with a symbol served from a saved copy ends with when the copy was saved", async () => {
  const savedAt = Date.parse("2026-10-22T21:49:00Z");
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => createTestQuote({ symbol, currency: "USD", marketState: "CLOSED" }),
      getPriceHistoryWithMetadata: async (symbol) => {
        const loaded = { resolution: "1d" as const, points: dailyBar(10) };
        return symbol === "MSFT" ? servedFromSavedCopy(loaded, savedAt) : loaded;
      },
    }),
  }, { format: "csv" });
  await collectSavedCopies(() => history.execute(["AAPL", "MSFT"], cli.context));
  const [{ result, options }] = cli.printed;
  expect(result.freshness?.savedAt).toBe("2026-10-22T21:49:00.000Z");
  expect(serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options)).toContain("couldn't refresh; saved copy from Thu 22 Oct 2026 21:49 UTC");
  // The same list from the live source says nothing of one.
  const live = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => createTestQuote({ symbol, currency: "USD", marketState: "CLOSED" }),
      getPriceHistoryWithMetadata: async () => ({ resolution: "1d" as const, points: dailyBar(10) }),
    }),
  }, { format: "csv" });
  await collectSavedCopies(() => history.execute(["AAPL", "MSFT"], live.context));
  expect(live.printed[0]!.result.freshness?.savedAt).toBeUndefined();
});

/**
 * A source with no quote for the bare symbol `FP` that still serves its bars, from one listing and with no currency
 * to say (as Gloom Cloud does), where search lists `FP` under `companies` by exchange. Every other symbol is an ordinary one.
 */
async function runBareSymbol(args: string[], companies: Record<string, string>) {
  const bars2025 = [{ date: new Date("2025-06-02"), open: 0.8, high: 0.8, low: 0.8, close: 0.8, volume: 1000 }];
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      search: async (query) => query.startsWith("FP")
        ? Object.entries(companies).map(([exchange, name]) => ({ providerId: "test", symbol: "FP", name, exchange, type: "Common Stock", currency: "CAD" }))
        : [],
      getQuote: async (symbol, exchange) => {
        if (symbol === "FP" && !exchange) throw new Error("No quote provider available for FP");
        return createTestQuote({ symbol, currency: symbol === "AAPL" ? "USD" : "CAD", marketState: "CLOSED" });
      },
      getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: bars2025 }),
      getDetailedPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: bars2025 }),
    }),
  }, { format: "csv" });
  // The real failure keeps the listings it offers in its details, which a list's status row says in one line.
  cli.context.fail = fail;
  const error = await history.execute(args, cli.context).then(() => null, (thrown: unknown) => thrown);
  return { error, result: cli.printed[0]?.result };
}

const FP_COMPANIES = { TSXV: "FP Newspapers Inc.", BVB: "S.C. Fondul Proprietatea S.A." };

test("a bare symbol several companies list is never served from the listing the source picked: a date window asks for an exchange as a range does", async () => {
  const window = ["--start", "2024", "--end", "2025"];
  for (const [args, retry] of [
    [["FP", ...window], "--from 2024-01-01 --to 2025-12-31"],
    [["FP", "--range", "1M"], "--range 1M"],
  ] as const) {
    const { error, result } = await runBareSymbol([...args], FP_COMPANIES);
    expect(result).toBeUndefined();
    expect(isCliFailure(error) && error.message).toBe("Choose an exchange for FP.");
    expect(isCliFailure(error) && error.details).toBe([
      "Listings:",
      `  FP:TSXV FP Newspapers Inc. (try: gloom history FP:TSXV ${retry})`,
      `  FP:BVB S.C. Fondul Proprietatea S.A. (try: gloom history FP:BVB ${retry})`,
    ].join("\n"));
  }

  // A window to today retries to the day it is run on.
  expect((await runBareSymbol(["FP", "--start", "2024"], FP_COMPANIES)).error).toMatchObject({
    details: expect.stringContaining("(try: gloom history FP:TSXV --from 2024-01-01)"),
  });

  // A listing named is its own answer, with its own currency.
  const named = await runBareSymbol(["FP:TSXV", ...window], FP_COMPANIES);
  expect(named.error).toBeNull();
  expect(named.result?.metadata).toMatchObject({ currency: "CAD", bars: 1 });
});

test("in a list a bare symbol several companies list is one status row while the others are served with their currency", async () => {
  for (const timing of [["--start", "2024", "--end", "2025"], ["--range", "1M"]]) {
    const { error, result } = await runBareSymbol(["FP", "AAPL", "FP:BVB", ...timing], FP_COMPANIES);
    expect(error).toBeNull();
    expect(result?.failure).toBeUndefined();
    expect((result?.data as Array<{ symbol: string; status?: string; currency: string | null }>).map((row) => [row.symbol, row.status ?? "", row.currency])).toEqual([
      ["FP", "Choose an exchange for FP. Listings: FP:TSXV, FP:BVB.", null],
      ["AAPL", "", "USD"],
      ["FP:BVB", "", "CAD"],
    ]);
    expect(result?.warnings).toContain("Choose an exchange for FP. Listings: FP:TSXV, FP:BVB.");
  }
});

test("a bare symbol one company lists, with no quote of its own, is still served as before", async () => {
  const same = { TSXV: "FP Newspapers Inc.", NEO: "FP Newspapers Inc." };
  for (const args of [["FP", "--start", "2024", "--end", "2025"], ["FP", "--range", "1M"]]) {
    const { error, result } = await runBareSymbol(args, same);
    expect(error).toBeNull();
    expect(result?.metadata).toMatchObject({ bars: 1 });
  }
});

test("a currency pair's bars count no volume: a source's 0 prints as missing in the table and stays empty in the export", async () => {
  setSystemTime(new Date("2026-10-26T12:00:00Z"));
  try {
    const run = async (format: "text" | "csv") => {
      const cli = createTestCliContext({
        config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
        dataProvider: createTestDataProvider({
          getQuote: async () => createTestQuote({ symbol: "EURUSD=X", currency: "USD", instrumentType: "CURRENCY", listingExchangeName: "CCY" }),
          getPriceHistoryWithMetadata: async () => ({
            resolution: "1d",
            points: [
              { date: new Date("2025-04-14"), open: 1.13417, high: 1.14247, low: 1.13007, close: 1.13533, volume: 0 },
              { date: new Date("2025-04-15"), open: 1.1352, high: 1.13792, low: 1.12689, close: 1.12854, volume: 0 },
            ],
          }),
        }),
      }, { format });
      await history.execute(["EURUSD=X", "--from", "2025-04-14", "--to", "2025-04-15"], cli.context);
      const [{ result, options }] = cli.printed;
      return { result, text: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format }, options) };
    };
    const text = await run("text");
    expect((text.result.data as Array<{ volume: unknown }>).map((row) => row.volume)).toEqual([null, null]);
    const table = text.text.split("\n").filter((line) => line.startsWith("2025-04-1"));
    expect(table).toHaveLength(2);
    for (const line of table) expect(line).not.toMatch(/\s0\s/);
    const csv = await run("csv");
    expect(csv.text.split("\n")[1]).toMatch(/^2025-04-14,1\.13417,1\.14247,1\.13007,1\.13533,,/);
  } finally {
    setSystemTime();
  }
});

/** Every rendering of a `history` run: the text table, the CSV and the JSON, as the command prints them. */
async function historyOutputs(args: string[], points: PriceHistoryResult["points"], quote: Parameters<typeof createTestQuote>[0]) {
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloom-history-command-fixture"),
    dataProvider: createTestDataProvider({
      getQuote: async () => createTestQuote({ currency: "USD", marketState: "CLOSED", ...quote }),
      getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points }),
      getPriceHistoryForResolutionWithMetadata: async (_symbol, _exchange, _range, resolution) => ({ resolution, points }),
      getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, _start, _end, interval) => ({ resolution: interval, points }),
    }),
  }, { format: "json" });
  await history.execute(args, cli.context);
  const [{ result, options }] = cli.printed;
  return {
    result,
    text: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, color: false }, options),
    csv: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options),
    json: serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, options),
  };
}

const sessionBars = (days: string[], volumes: number[], time = "T00:00:00Z", contracts: string[] = []) => days.map((day, index) => {
  const close = 100 + index;
  return { date: new Date(`${day}${time}`), open: close, high: close, low: close, close, volume: volumes[index]!,
    ...(contracts[index] ? { contract: contracts[index] } : {}) };
});
const OCT_DAYS = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
const QUIET_VOLUMES = [160_000, 150_000, 140_000, 155_000, 145_000, 150_000, 148_000, 15, 152_000, 0];

/**
 * A stock's day on 15 shares among days of 150,000, and a session with none, are no futures contract's thin bar:
 * a stock's and an intraday history print as they did before contracts were read, the same bytes in text, CSV and JSON.
 */
test("a stock's daily and intraday history is unchanged by the futures marks: no thin bar, no roll, no contract column", async () => {
  setSystemTime(new Date("2026-10-31T12:00:00Z"));
  try {
    const daily = await historyOutputs(["ACME", "--range", "1M"], sessionBars(OCT_DAYS, QUIET_VOLUMES), { symbol: "ACME", name: "Acme Corp", listingExchangeName: "NYSE" });
    expect(daily.text).toBe([
      "Acme Corp  ·  New York Stock Exchange (NYSE)",
      "Currency USD  ·  daily bars  ·  2026-10-19 to 2026-10-30  ·  10 bars",
      "Max drawdown 0.0% (daily closes): no close fell below an earlier one",
      "Date          Open    High     Low   Close   Volume",
      "──────────  ──────  ──────  ──────  ──────  ───────",
      "2026-10-19  100.00  100.00  100.00  100.00  160,000",
      "2026-10-20  101.00  101.00  101.00  101.00  150,000",
      "2026-10-21  102.00  102.00  102.00  102.00  140,000",
      "2026-10-22  103.00  103.00  103.00  103.00  155,000",
      "2026-10-23  104.00  104.00  104.00  104.00  145,000",
      "2026-10-26  105.00  105.00  105.00  105.00  150,000",
      "2026-10-27  106.00  106.00  106.00  106.00  148,000",
      "2026-10-28  107.00  107.00  107.00  107.00       15",
      "2026-10-29  108.00  108.00  108.00  108.00  152,000",
      "2026-10-30  109.00  109.00  109.00  109.00        0",
      "",
      "Source: Gloom Cloud · Fri 30 Oct 2026 · not a live feed (daily closes)",
    ].join("\n"));
    expect(daily.csv.split("\n")[0]).toBe(`${HISTORY_CSV_HEADER},symbol_or_series,currency_or_unit,interval,source,as_of`);
    expect(daily.csv.split("\n")[8]).toBe("2026-10-28,107,107,107,107,15,,false,false,false,,,,,,,ACME,USD,1d,Gloom Cloud,2026-10-30");
    expect(daily.json).not.toMatch(/"(contract|roll|thin)"/);
    expect((daily.result.warnings ?? []).join("\n")).not.toMatch(/thin|roll/);

    const intraday = await historyOutputs(["ACME", "--range", "1D", "--interval", "15m"],
      sessionBars(OCT_DAYS.map(() => "2026-10-30"), QUIET_VOLUMES).map((bar, index) => ({ ...bar, date: new Date(Date.parse("2026-10-30T14:30:00Z") + index * 900_000) })),
      { symbol: "ACME", name: "Acme Corp", listingExchangeName: "NYSE" });
    expect(intraday.text).not.toMatch(/thin|roll|front month/);
    expect(intraday.csv.split("\n")[0]).toBe(`${HISTORY_CSV_HEADER},symbol_or_series,currency_or_unit,interval,source,as_of`);
    expect(intraday.json).not.toMatch(/"(contract|roll|thin)"/);
  } finally {
    setSystemTime();
  }
});

/** `history NG=F --range 1M` on 30 Oct 2026 read November's bars and December's as one contract headed "Natural Gas Dec 2026". */
test("a continuous future's history is headed as the front month, flags the roll and a thin bar, and exports each bar's contract", async () => {
  setSystemTime(new Date("2026-10-31T12:00:00Z"));
  try {
    const contracts = OCT_DAYS.map((day) => day < "2026-10-26" ? "NGX26" : "NGZ26");
    const volumes = [...QUIET_VOLUMES.slice(0, -1), 151_000];
    const { result, text, csv } = await historyOutputs(["NG=F", "--range", "1M"], sessionBars(OCT_DAYS, volumes, "T00:00:00Z", contracts),
      { symbol: "NG=F", name: "Natural Gas Dec 2026", listingExchangeName: "NYMEX", instrumentType: "Future" });
    const lines = text.split("\n");
    expect(lines[0]).toStartWith("Natural Gas front month");
    expect(lines.find((line) => line.startsWith("2026-10-26"))).toEndWith("roll to NGZ26");
    expect(lines.find((line) => line.startsWith("2026-10-28"))).toEndWith("thin");
    expect(lines.filter((line) => /roll to|thin$/.test(line))).toHaveLength(2);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "NG=F is the front month: rolled from NGX26 to NGZ26 on 2026-10-26 (marked roll); drawdowns are read within one contract",
      "2026-10-28 traded thin: under 5% of the volume of the bars around it",
    ]));
    const [header, ...rows] = csv.split("\n");
    expect(header).toBe(`${HISTORY_CSV_HEADER.replace(",status", ",Contract,Roll,Thin,status")},symbol_or_series,currency_or_unit,interval,source,as_of`);
    const cells = (date: string) => rows.find((row) => row.startsWith(date))!.split(",").slice(15, 18);
    expect(cells("2026-10-23")).toEqual(["NGX26", "false", "false"]);
    expect(cells("2026-10-26")).toEqual(["NGZ26", "true", "false"]);
    expect(cells("2026-10-28")).toEqual(["NGZ26", "false", "true"]);
  } finally {
    setSystemTime();
  }
});
