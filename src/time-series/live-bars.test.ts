import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../types/financials";
import { createTestDataProvider } from "../test-support/data-provider";
import type { HistorySession } from "../types/price-history";
import { LiveBarAccumulator } from "./live-bars";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { resolveChartSpecData } from "./resolve";
import { ChartResolveCache, type ChartResolveSources } from "./resolve-context";
import { reconcileChartTail } from "./tail-reconcile";
import { mergePriceHistoryWindows } from "./history-acquisition";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";

const at = (time: string) => Date.parse(`2026-09-22T${time}Z`);

function quote(time: string, price: number, volume?: number, overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "LIVE", price, currency: "USD", change: 0, changePercent: 0,
    lastUpdated: at(time), listingExchangeName: "NASDAQ", marketState: "REGULAR",
    ...(volume === undefined ? {} : { volume }),
    ...overrides,
  };
}

function bar(time: string, open: number, high: number, low: number, close: number, volume: number): PricePoint {
  return { date: new Date(at(time)), open, high, low, close, volume };
}

function dated(date: string, open: number, high: number, low: number, close: number, volume: number): PricePoint {
  return { date: new Date(`${date}T00:00:00Z`), open, high, low, close, volume };
}

describe("LiveBarAccumulator", () => {
  test("folds every quote into the forming bar and opens a new bar at each boundary", () => {
    const history = [bar("14:00:00", 100, 101, 99, 100, 5_000), bar("14:01:00", 100, 100.5, 99.5, 100, 800)];
    const bars = new LiveBarAccumulator();
    const apply = (next: Quote) => bars.apply(history, next,
      { now: next.lastUpdated + 100, resolution: "1m", exchange: "NASDAQ", liveSince: at("14:01:10") });

    apply(quote("14:01:20", 101, 90_000));
    apply(quote("14:01:40", 102.5, 90_100));
    let points = apply(quote("14:01:50", 100.5, 90_150));
    // The loaded bar keeps its open and gains the watched extremes and trades.
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ open: 100, high: 102.5, low: 99.5, close: 100.5, volume: 950 });
    expect(history[1]).toMatchObject({ high: 100.5, close: 100, volume: 800 });

    points = apply(quote("14:02:05", 101, 90_200));
    expect(points).toHaveLength(3);
    expect(points[2]).toMatchObject({ date: new Date(at("14:02:00")), open: 101, high: 101, low: 101, close: 101, volume: 50 });

    apply(quote("14:02:30", 103, 90_260));
    points = apply(quote("14:03:10", 99, 90_300));
    expect(points.map((point) => point.date.getTime())).toEqual(
      ["14:00:00", "14:01:00", "14:02:00", "14:03:00"].map(at));
    // A closed bar's volume stops at the trade count when the next bar opened.
    expect(points[1]?.volume).toBe(950);
    expect(points[2]).toMatchObject({ open: 101, high: 103, low: 101, close: 103, volume: 110 });
    expect(points[3]).toMatchObject({ open: 99, close: 99, volume: 40 });

    // A quiet stretch while watching is not missing history.
    points = apply(quote("14:09:30", 98, 90_310));
    expect(points.at(-1)).toMatchObject({ date: new Date(at("14:09:00")), close: 98, volume: 10 });
    expect(bars.takeReconcileRequest()).toBe(false);
  });

  test("asks for recent history instead of bridging a gap it did not watch", () => {
    const history = [bar("14:00:00", 100, 101, 99, 100, 5_000), bar("14:01:00", 100, 100.5, 99.5, 100, 800)];
    const bars = new LiveBarAccumulator();
    const next = quote("14:20:00", 104, 120_000);
    const points = bars.apply(history, next, { now: next.lastUpdated, resolution: "1m", exchange: "NASDAQ", liveSince: at("14:19:00") });
    expect(points).toBe(history);
    expect(bars.takeReconcileRequest()).toBe(true);
    expect(bars.takeReconcileRequest()).toBe(false);
  });

  test("extended-hours prints never form intraday bars the regular-session history cannot confirm", () => {
    const history = [bar("19:58:00", 100, 101, 99, 100, 5_000), bar("19:59:00", 100, 100.5, 99.5, 100.2, 800)];
    const bars = new LiveBarAccumulator();
    const post = quote("20:01:00", 100.4, 90_000, { marketState: "POST", postMarketPrice: 99 });
    expect(bars.apply(history, post, { now: post.lastUpdated, resolution: "1m", exchange: "NASDAQ", liveSince: at("19:00:00") }))
      .toBe(history);
  });

  test("a history with extended hours forms after-hours bars at the after-hours price, not past their close", () => {
    const history = [bar("19:58:00", 100, 101, 99, 100, 5_000), bar("19:59:00", 100, 100.5, 99.5, 100.2, 800)];
    const bars = new LiveBarAccumulator();
    const options = (next: Quote) => ({ now: next.lastUpdated, resolution: "1m" as const, exchange: "NASDAQ", liveSince: at("19:00:00"), extendedHours: true });
    const post = quote("20:01:00", 100.4, 90_000, { marketState: "POST", postMarketPrice: 99 });
    expect(bars.apply(history, post, options(post)).at(-1)).toMatchObject({ date: new Date(at("20:01:00")), close: 99 });
    // Past the after-hours close, quotes form nothing.
    const overnight = quote("23:59:30", 98.5, 90_000, { marketState: "POSTPOST", postMarketPrice: 98.5 });
    expect(bars.apply(history, overnight, options(overnight)).at(-1)).toMatchObject({ date: new Date(at("20:01:00")), close: 99 });
  });

  test("updates today's daily candle and starts the next session's candle on its date label", () => {
    const history = [bar("00:00:00", 100, 104, 98, 103, 40_000_000)];
    const bars = new LiveBarAccumulator();
    const options = (next: Quote) => ({ now: next.lastUpdated, resolution: "1d" as const, exchange: "NASDAQ" });
    let next = quote("15:00:00", 105, 41_000_000);
    bars.apply(history, next, options(next));
    next = quote("15:30:00", 97, 41_500_000);
    let points = bars.apply(history, next, options(next));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ open: 100, high: 105, low: 97, close: 97, volume: 40_500_000 });

    // The next session's count starts from zero and all of it is today's,
    // even when the first quote seen arrives mid-morning. Nothing is taken
    // back from yesterday.
    next = { ...quote("15:00:00", 99, 2_000_000), lastUpdated: Date.parse("2026-09-23T15:00:00Z") };
    bars.apply(history, next, options(next));
    next = { ...quote("15:00:00", 101, 2_600_000), lastUpdated: Date.parse("2026-09-23T15:10:00Z") };
    points = bars.apply(history, next, options(next));
    expect(points).toHaveLength(2);
    expect(points[0]?.volume).toBe(40_500_000);
    expect(points[1]).toMatchObject({ date: new Date("2026-09-23T00:00:00Z"), open: 99, high: 101, low: 99, close: 101, volume: 2_600_000 });
  });

  describe("a calendar bar formed from the quote takes the session's own range", () => {
    // Tuesday 22 Sep 2026: the history ends on Monday's candle, as a fresh process reads it.
    const history = [dated("2026-09-21", 100, 104, 98, 103, 40_000_000)];
    const options = (next: Quote) => ({ now: next.lastUpdated, resolution: "1d" as const, exchange: "NASDAQ" });
    const session = { open: 101, high: 106, low: 100.5 };

    test("mid-session: open, high and low from the quote, widened by later prints", () => {
      const bars = new LiveBarAccumulator();
      let next = quote("15:00:00", 105, 12_000_000, session);
      expect(bars.apply(history, next, options(next)).at(-1)).toEqual({
        date: new Date("2026-09-22T00:00:00Z"), open: 101, high: 106, low: 100.5, close: 105, volume: 12_000_000,
      });
      next = quote("15:30:00", 107, 13_000_000, { ...session, high: 107.2 });
      expect(bars.apply(history, next, options(next)).at(-1)).toMatchObject({ open: 101, high: 107.2, low: 100.5, close: 107, volume: 13_000_000 });
      // A quote without the session's range falls back to the prints alone.
      next = quote("16:00:00", 99, 14_000_000);
      expect(bars.apply(history, next, options(next)).at(-1)).toMatchObject({ open: 101, high: 107.2, low: 99, close: 99 });
      expect(new LiveBarAccumulator().apply(history, next, options(next)).at(-1)).toMatchObject({ open: 99, high: 99, low: 99, close: 99 });
    });

    test("inside the settle window after the close: the session's range, closing at the regular close", () => {
      const closed = (time: string, print: number): Quote => quote(time, print, 40_000_000, {
        ...session, marketState: "POST", postMarketPrice: print, changeSessionDate: "2026-09-22", regularClose: 103.5,
        regularCloseSessionDate: "2026-09-22", regularChange: 0.5, regularChangePercent: 0.48,
      });
      const bars = new LiveBarAccumulator();
      let next = closed("20:10:00", 102.5);
      expect(bars.apply(history, next, options(next)).at(-1)).toMatchObject({
        date: new Date("2026-09-22T00:00:00Z"), open: 101, high: 106, low: 100.5, close: 103.5, volume: 40_000_000,
      });
      // An after-hours print below the day's low is not part of the session.
      next = closed("20:20:00", 95);
      expect(bars.apply(history, next, options(next)).at(-1)).toMatchObject({ open: 101, high: 106, low: 100.5, close: 103.5 });
    });

    test("a range that belongs to another session, or to other units, is not taken", () => {
      let next = quote("15:00:00", 105, 12_000_000, { ...session, changeSessionDate: "2026-09-21" });
      expect(new LiveBarAccumulator().apply(history, next, options(next)).at(-1)).toMatchObject({ open: 105, high: 105, low: 105 });
      next = quote("15:00:00", 105, 12_000_000, { open: 10_100, high: 10_600, low: 10_050 });
      expect(new LiveBarAccumulator().apply(history, next, options(next)).at(-1)).toMatchObject({ open: 105, high: 105, low: 105 });
    });
  });

  describe("a weekly or monthly bar keeps the open of its period", () => {
    const options = (next: Quote, resolution: "1wk" | "1mo") => ({ now: next.lastUpdated, resolution, exchange: "NASDAQ" });
    const day = (date: string, time: string, price: number, overrides: Partial<Quote>): Quote =>
      ({ ...quote("00:00:00", price, 30_000_000, overrides), lastUpdated: Date.parse(`${date}T${time}Z`) });

    test("history holding earlier days of the period: the open stays, the range widens", () => {
      // Thursday's session over the week's bar from Monday.
      const history = [dated("2026-09-14", 98, 101, 96, 99, 150_000_000), dated("2026-09-21", 100, 104, 98, 103, 90_000_000)];
      const next = day("2026-09-24", "15:00:00", 107, { open: 103.5, high: 108, low: 102 });
      expect(new LiveBarAccumulator().apply(history, next, options(next, "1wk")).at(-1)).toMatchObject({
        date: new Date("2026-09-21T00:00:00Z"), open: 100, high: 108, low: 98, close: 107,
      });
      const monthly = [dated("2026-08-01", 90, 99, 88, 97, 2_000_000_000), dated("2026-09-01", 97, 104, 94, 103, 1_000_000_000)];
      expect(new LiveBarAccumulator().apply(monthly, next, options(next, "1mo")).at(-1)).toMatchObject({
        date: new Date("2026-09-01T00:00:00Z"), open: 97, high: 108, low: 94, close: 107,
      });
    });

    test("a period's first session opens its bar with its own open; a later one cannot name the period's", () => {
      const weekly = [dated("2026-09-14", 98, 101, 96, 99, 150_000_000)];
      // Monday 21 Sep opens the week.
      let next = day("2026-09-21", "15:00:00", 105, { open: 101, high: 106, low: 100.5 });
      expect(new LiveBarAccumulator().apply(weekly, next, options(next, "1wk")).at(-1)).toMatchObject({
        date: new Date("2026-09-21T00:00:00Z"), open: 101, high: 106, low: 100.5, close: 105,
      });
      // Tuesday's session is the week's second: its open is not the week's.
      next = day("2026-09-22", "15:00:00", 105, { open: 101, high: 106, low: 100.5 });
      expect(new LiveBarAccumulator().apply(weekly, next, options(next, "1wk")).at(-1)).toMatchObject({
        date: new Date("2026-09-21T00:00:00Z"), open: 105, high: 106, low: 100.5, close: 105,
      });
      // Thursday 1 Oct opens October; Friday 2 Oct is its second session.
      const monthly = [dated("2026-09-01", 97, 104, 94, 103, 1_000_000_000)];
      next = day("2026-10-01", "15:00:00", 105, { open: 101, high: 106, low: 100.5 });
      expect(new LiveBarAccumulator().apply(monthly, next, options(next, "1mo")).at(-1)).toMatchObject({
        date: new Date("2026-10-01T00:00:00Z"), open: 101, high: 106, low: 100.5,
      });
      next = day("2026-10-02", "15:00:00", 105, { open: 101, high: 106, low: 100.5 });
      expect(new LiveBarAccumulator().apply(monthly, next, options(next, "1mo")).at(-1)).toMatchObject({
        date: new Date("2026-10-01T00:00:00Z"), open: 105, high: 106, low: 100.5,
      });
    });
  });

  test("an overnight price moves no daily candle: no history covers that session", () => {
    const history = [bar("00:00:00", 100, 104, 98, 103, 40_000_000)];
    const options = (next: Quote) => ({ now: next.lastUpdated, resolution: "1d" as const, exchange: "NASDAQ" });
    // Tuesday 22:30 New York, after the after-hours session.
    const evening = { ...quote("00:00:00", 104.2, 40_000_000, { marketState: "POSTPOST", changeSessionDate: "2026-09-22" }),
      lastUpdated: Date.parse("2026-09-23T02:30:00Z") };
    expect(new LiveBarAccumulator().apply(history, evening, options(evening)).at(-1)).toMatchObject({ close: 104.2 });
    const overnight: Quote = { ...evening, overnightPrice: 104.2, overnightPriceKind: "trade" };
    expect(new LiveBarAccumulator().apply(history, overnight, options(overnight))).toEqual(history);
  });

  test("a pre-market print opens no daily candle; the regular session opens it with its own count", () => {
    const history = [bar("00:00:00", 100, 104, 98, 103, 40_000_000)];
    const bars = new LiveBarAccumulator();
    const options = (next: Quote) => ({ now: next.lastUpdated, resolution: "1d" as const, exchange: "NASDAQ" });
    // Still carrying yesterday's count.
    let next: Quote = { ...quote("00:00:00", 103, 40_000_000, { marketState: "PRE", preMarketPrice: 104 }),
      lastUpdated: Date.parse("2026-09-23T12:00:00Z") };
    expect(bars.apply(history, next, options(next))).toBe(history);
    // The regular session's count starts on the same date, here first seen mid-morning.
    next = { ...quote("00:00:00", 105, 25_000_000), lastUpdated: Date.parse("2026-09-23T15:00:00Z") };
    const points = bars.apply(history, next, options(next));
    expect(points[0]?.volume).toBe(40_000_000);
    expect(points[1]).toMatchObject({ date: new Date("2026-09-23T00:00:00Z"), close: 105, volume: 25_000_000 });
  });

  test("after the close the daily candle holds at the regular close while after-hours prints arrive", () => {
    const history = [bar("00:00:00", 100, 104, 98, 103, 40_000_000)];
    const bars = new LiveBarAccumulator();
    const options = (next: Quote) => ({ now: next.lastUpdated, resolution: "1d" as const, exchange: "NASDAQ" });
    // As Gloom Cloud sends it in the after-hours session: the close, the session's print beside it.
    const closed = (time: string, print: number): Quote => quote(time, 103.5, 40_000_000, {
      marketState: "POST", postMarketPrice: print, changeSessionDate: "2026-09-22", regularClose: 103.5,
      regularCloseSessionDate: "2026-09-22", regularChange: 1.5, regularChangePercent: 1.47,
    });
    bars.apply(history, closed("20:30:00", 99), options(closed("20:30:00", 99)));
    let points = bars.apply(history, closed("23:30:00", 97), options(closed("23:30:00", 97)));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ high: 104, low: 98, close: 103.5 });
    // Past the after-hours session the price is the last print, and the close still stands.
    const evening: Quote = { ...closed("00:00:00", 96.5), price: 96.5, marketState: "POSTPOST", lastUpdated: Date.parse("2026-09-23T00:30:00Z") };
    points = bars.apply(history, evening, options(evening));
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ low: 98, close: 103.5 });
  });

  test("regular bars keep extended-hours prints out, including a bar still open after the close", () => {
    const history = [bar("18:30:00", 100, 101, 99, 100, 5_000), bar("19:30:00", 100, 100.5, 99.5, 100.2, 800)];
    const bars = new LiveBarAccumulator();
    const post = quote("20:10:00", 100.2, 90_000, { marketState: "POST", postMarketPrice: 97 });
    const points = bars.apply(history, post, { now: post.lastUpdated, resolution: "1h", exchange: "NASDAQ", liveSince: at("19:00:00") });
    expect(points.at(-1)).toMatchObject({ low: 99.5, close: 100.2 });
  });

  describe("a history ending in a trade-time observation", () => {
    // 5m bars, then the latest trade stamped at 14:23.
    const history = [
      bar("14:15:00", 100, 101, 99.5, 100.5, 4_000),
      bar("14:20:00", 100.5, 101, 100, 100.8, 3_000),
      bar("14:23:00", 100.9, 101.4, 100.9, 101.4, 200),
    ];
    const session: Pick<HistorySession, "timestampConvention" | "observedAt"> = {
      timestampConvention: "bar-open-with-final-observation", observedAt: at("14:23:05"),
    };

    for (const [label, declared] of [["declared by its source", session], ["undeclared", undefined]] as const) {
      test(`folds it into its bar and forms later bars on the source's grid (${label})`, () => {
        const bars = new LiveBarAccumulator();
        const apply = (next: Quote) => bars.apply(history, next,
          { now: next.lastUpdated + 100, resolution: "5m", exchange: "NASDAQ", liveSince: at("14:23:30"), session: declared });
        apply(quote("14:24:00", 101.6));
        apply(quote("14:26:00", 101.2));
        apply(quote("14:29:00", 101.0));
        const points = apply(quote("14:31:00", 100.7));
        expect(points.map((point) => point.date.toISOString().slice(11, 16))).toEqual(["14:15", "14:20", "14:25", "14:30"]);
        expect(points[1]).toMatchObject({ open: 100.5, high: 101.6, low: 100, close: 101.6, volume: 3_200 });
        expect(points[2]).toMatchObject({ open: 101.2, high: 101.2, low: 101.0, close: 101.0 });
        expect(points[3]).toMatchObject({ open: 100.7, close: 100.7 });
      });
    }

    test("a declared closing print ends the last bar instead of opening one", () => {
      const close = [bar("19:50:00", 100, 101, 99.5, 100.5, 4_000), bar("19:55:00", 100.5, 101, 100, 100.8, 3_000),
        bar("20:00:00", 100.7, 100.7, 100.7, 100.7, 0)];
      const points = new LiveBarAccumulator().apply(close, null, { now: at("20:05:00"), resolution: "5m", session });
      expect(points).toHaveLength(2);
      expect(points[1]).toMatchObject({ date: new Date(at("19:55:00")), close: 100.7, volume: 3_000 });
    });

    test("a partial opening bar followed by clock-aligned bars is not an observation", () => {
      const opening = [bar("19:00:00", 100, 101, 99, 100, 5_000), bar("13:30:00", 100, 101, 99, 100.5, 900),
        bar("14:00:00", 100.5, 101.5, 100, 101, 700)];
      opening[0] = { ...opening[0]!, date: new Date(Date.parse("2026-09-21T19:00:00Z")) };
      const points = new LiveBarAccumulator().apply(opening, null, { now: at("14:10:00"), resolution: "1h" });
      expect(points).toBe(opening);
    });

    test("a later window supersedes the earlier observation inside one of its bars", () => {
      const window = [bar("14:20:00", 100.5, 101.4, 100, 101.2, 3_600), bar("14:25:00", 101.2, 101.6, 101, 101.3, 900)];
      expect(mergePriceHistoryWindows(history, window, "5m").map((point) => point.date.toISOString().slice(11, 16)))
        .toEqual(["14:15", "14:20", "14:25"]);
      // An observation after the window's last bar is newer than it and stays.
      expect(mergePriceHistoryWindows(history, window.slice(0, 1), "5m")).toHaveLength(3);
    });
  });
});

describe("reconcileChartTail", () => {
  const source = { kind: "security" as const, instrument: { symbol: "LIVE", exchange: "NASDAQ" }, fieldId: "market.ohlcv" };
  const spec: ChartSpec = {
    version: CHART_SPEC_VERSION,
    viewport: { range: "1D", resolution: "1m" },
    panels: [{ id: "main" }],
    series: [{ id: "price", source, style: "candles", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
    studies: [],
  };

  test("settles formed bars to the provider's recent window without reloading the whole history", async () => {
    const detailRequests: Array<[Date, Date]> = [];
    let historyCalls = 0;
    let tail: PricePoint[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getPriceHistoryForResolution: async () => {
        historyCalls += 1;
        return [bar("14:00:00", 100, 101, 99, 100, 5_000), bar("14:01:00", 100, 100.5, 99.5, 100, 800)];
      },
      getDetailedPriceHistory: async (_symbol, _exchange, start, end) => {
        detailRequests.push([start, end]);
        return tail;
      },
    });
    const cache = new ChartResolveCache();
    const resolve = (time: string, price: number, volume: number) => {
      const sources: ChartResolveSources = {
        dataProvider: provider,
        now: new Date(at(time) + 100),
        liveSince: at("14:01:10"),
        loadFredSeries: async () => { throw new Error("unused"); },
        quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(source), quote(time, price, volume)]]),
      };
      return resolveChartSpecData(spec, sources, cache);
    };
    const bars = async (result: Promise<Awaited<ReturnType<typeof resolveChartSpecData>>>) =>
      ((await result).bufferedSeries ?? []).find((series) => series.id === "price")!.points
        .map(({ date, open, high, low, close, volume }) => ({ time: date.toISOString().slice(11, 16), open, high, low, close, volume }));

    await resolve("14:01:30", 101, 90_000);
    await resolve("14:02:10", 102, 90_300);
    expect((await bars(resolve("14:02:20", 104, 90_400))).slice(-2)).toEqual([
      { time: "14:01", open: 100, high: 101, low: 99.5, close: 101, volume: 800 },
      { time: "14:02", open: 102, high: 104, low: 102, close: 104, volume: 400 },
    ]);

    // The provider's final 14:01 bar replaces the formed one; its partial
    // 14:02 bar keeps the extremes and latest price watched since.
    tail = [bar("14:01:00", 100, 101.2, 99.4, 101.1, 1_150), bar("14:02:00", 101.1, 103, 101, 102.5, 150)];
    expect(await reconcileChartTail({ dataProvider: provider }, cache, at("14:02:25"))).toBe(true);
    // Whole-bar and whole-minute bounds, so charts asking at once share it.
    expect(detailRequests).toEqual([[new Date(at("14:00:00")), new Date(at("14:03:00"))]]);
    expect((await bars(resolve("14:02:40", 103.5, 90_450))).slice(-3)).toEqual([
      { time: "14:00", open: 100, high: 101, low: 99, close: 100, volume: 5_000 },
      { time: "14:01", open: 100, high: 101.2, low: 99.4, close: 101.1, volume: 1_150 },
      { time: "14:02", open: 101.1, high: 104, low: 101, close: 103.5, volume: 200 },
    ]);
    expect(historyCalls).toBe(1);

    // An unchanged window is not a change.
    expect(await reconcileChartTail({ dataProvider: provider }, cache, at("14:02:50"))).toBe(false);
  });

  test("windows ending in a trade-time observation settle without stray or off-grid candles", async () => {
    const five = { ...spec, viewport: { range: "1D" as const, resolution: "5m" as const } };
    let tail: PricePoint[] = [];
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getPriceHistoryForResolution: async () => [bar("14:15:00", 100, 101, 99.5, 100.5, 4_000),
        bar("14:20:00", 100.5, 101, 100, 100.8, 3_000), bar("14:23:00", 100.9, 101.4, 100.9, 101.4, 200)],
      getDetailedPriceHistory: async () => tail,
    });
    const cache = new ChartResolveCache();
    const resolve = async (time: string, price: number) => ((await resolveChartSpecData(five, {
      dataProvider: provider, now: new Date(at(time) + 100), liveSince: at("14:23:30"),
      loadFredSeries: async () => { throw new Error("unused"); },
      quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(source), quote(time, price)]]),
    }, cache)).bufferedSeries ?? []).find((series) => series.id === "price")!.points
      .map(({ date, close }) => `${date.toISOString().slice(11, 16)}=${close}`);

    await resolve("14:24:00", 101.6);
    expect(await resolve("14:26:00", 101.2)).toEqual(["14:15=100.5", "14:20=101.6", "14:25=101.2"]);
    tail = [bar("14:20:00", 100.5, 101.6, 100, 101.5, 3_500), bar("14:25:00", 101.5, 101.5, 101.1, 101.2, 600),
      bar("14:26:00", 101.2, 101.2, 101.2, 101.2, 50)];
    expect(await reconcileChartTail({ dataProvider: provider }, cache, at("14:26:10"))).toBe(true);
    expect(await resolve("14:29:00", 101.0)).toEqual(["14:15=100.5", "14:20=101.5", "14:25=101"]);
    expect(await resolve("14:31:00", 100.7)).toEqual(["14:15=100.5", "14:20=101.5", "14:25=101", "14:30=100.7"]);
  });

  test("charts of the same history settling at the same boundary share one request", async () => {
    let detailCalls = 0;
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getPriceHistoryForResolution: async () => [bar("14:00:00", 100, 101, 99, 100, 5_000), bar("14:01:00", 100, 100.5, 99.5, 100, 800)],
      getDetailedPriceHistory: async () => {
        detailCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [bar("14:01:00", 100, 101.2, 99.4, 101.1, 1_150), bar("14:02:00", 101.1, 103, 101, 102.5, 150)];
      },
    });
    const caches = [new ChartResolveCache(), new ChartResolveCache()];
    for (const cache of caches) {
      await resolveChartSpecData(spec, { dataProvider: provider, now: new Date(at("14:01:30")),
        loadFredSeries: async () => { throw new Error("unused"); } }, cache);
    }
    const settled = await Promise.all([
      reconcileChartTail({ dataProvider: provider }, caches[0]!, at("14:02:05")),
      reconcileChartTail({ dataProvider: provider }, caches[1]!, at("14:02:07")),
    ]);
    expect(settled).toEqual([true, true]);
    expect(detailCalls).toBe(1);
  });
});
