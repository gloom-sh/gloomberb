import { describe, expect, setSystemTime, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { CorporateActionsData, PricePoint, Quote } from "../types/financials";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { resolvePriceComparison } from "./price-comparison";
import { resolveChartSpecData } from "./resolve";
import { ChartResolveCache } from "./resolve-context";
import { seedChartResolutionResult } from "./chart-seed";
import { summarizeResolvedSeries } from "./reporting";
import { CHART_SPEC_VERSION, type ChartSpec } from "./types";

const date = (day: string) => new Date(day);
const rows = (values: [string, number][]): PricePoint[] => values.map(([day, close]) => ({ date: date(day), close }));
const spec = (resolution: "1d" | "1wk" = "1d"): ChartSpec => ({
  version: CHART_SPEC_VERSION,
  viewport: { range: "5Y", resolution, dateWindow: { start: "2021-01-01", end: "2026-09-10" } },
  panels: [{ id: "main" }], studies: [],
  series: ["OLDER", "NEWER"].map((symbol) => ({
    id: symbol, source: { kind: "security", instrument: { symbol, exchange: "NASDAQ" }, fieldId: "market.close" },
    style: "line", transform: "percent", axis: "left", panelId: "main", interpolation: "none",
  })),
});
const histories = {
  OLDER: rows([["2021-01-04", 100], ["2022-05-02", 80], ["2022-05-09", 90], ["2026-09-07", 180], ["2026-09-10", 200]]),
  NEWER: rows([["2022-05-02", 50], ["2022-05-09", 55], ["2026-09-07", 60]]),
};
function sources(history: Record<string, PricePoint[]> = histories) {
  const getHistory = async (symbol: string) => history[symbol] ?? [];
  return {
    now: date("2026-09-10T18:00:00Z"),
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, currency: "USD", instrumentType: "ETF", price: 999, change: 0, changePercent: 50, lastUpdated: Date.parse("2026-09-10T18:00:00Z") }),
      getTickerFinancials: async (symbol) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: history[symbol] ?? [] }),
      getDetailedPriceHistory: getHistory,
      getPriceHistory: getHistory,
      getPriceHistoryForResolution: getHistory,
    }),
    loadFredSeries: async () => ({ data: { observations: [], info: null }, fetchedAt: 0, stale: false, source: "network" as const }),
  };
}

describe("normalized market price comparison", () => {
  for (const resolution of ["1d", "1wk"] as const) {
    test(`${resolution} uses shared inception and endpoint in chart, buffered rendering and raw report`, async () => {
      const result = await resolveChartSpecData(spec(resolution), sources());
      expect(result.priceComparison).toMatchObject({ start: Date.parse("2022-05-02"), end: Date.parse("2026-09-07") });
      for (const collection of [result.series, result.bufferedSeries!, result.legendSeries!]) {
        expect(collection.map((s) => s.points[0]?.value)).toEqual([0, 0]);
        expect(collection.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
        expect(collection.map((s) => s.latestChangePercent)).toEqual([undefined, undefined]);
      }
      expect(summarizeResolvedSeries(result.series[0]!)).toMatchObject({
        startDate: "2022-05-02T00:00:00.000Z", endDate: "2026-09-07T00:00:00.000Z", startValue: 80, endValue: 180, return: 1.25,
      });
      expect(histories.OLDER[0]?.close).toBe(100);
      const seeded = seedChartResolutionResult(spec(resolution), new Map(spec().series.map((s) => [chartQuoteOverrideKeyForSource(s.source), histories[s.id as keyof typeof histories]])));
      expect(seeded?.series.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
      expect(seeded?.priceComparison?.start).toBe(result.priceComparison?.start);
    });
  }

  test("total return reinvests each leg's cash at its ex-date close, names its basis, and leaves a leg without a history on price", async () => {
    const chart = { ...spec(), viewport: { ...spec().viewport, totalReturn: true } };
    const data = {
      OLDER: rows([["2022-05-02", 100], ["2022-05-09", 100], ["2022-05-16", 95], ["2022-05-23", 95]]),
      NEWER: rows([["2022-05-02", 50], ["2022-05-09", 50], ["2022-05-16", 50], ["2022-05-23", 55]]),
    };
    const actions = (symbol: string): CorporateActionsData => ({
      symbol, currency: "USD", coverage: { dividends: "available" }, splits: [], earnings: [],
      dividends: symbol === "OLDER" ? [{ exDate: "2022-05-16", amount: 5 }] : [],
    });
    const withActions = (getCorporateActions: (symbol: string) => Promise<CorporateActionsData>) => {
      const base = sources(data);
      // The price currency is the listing's, from its quote metadata.
      const getQuoteMetadata = async (symbol: string) => ({ symbol, currency: "USD", instrumentType: "EQUITY", listingExchangeName: "NASDAQ", source: {} });
      return { ...base, dataProvider: new Proxy(base.dataProvider, { get: (target, property, receiver) => (
        property === "getCorporateActions" ? getCorporateActions
          : property === "getQuoteMetadata" ? getQuoteMetadata : Reflect.get(target, property, receiver)
      ) }) };
    };

    const result = await resolveChartSpecData(chart, withActions(async (symbol) => actions(symbol)));
    // OLDER paid 5 on a 95 close: 95 + 5 over 100 is flat, so it holds at 0%; NEWER paid nothing and is its price.
    expect(result.series.map((entry) => entry.points.at(-1)?.value)).toEqual([0, 10]);
    expect(result.series.map((entry) => [entry.returnBasis, entry.label])).toEqual([
      ["total", "OLDER:XNAS Total return"], ["total", "NEWER:XNAS Total return"]]);
    expect(result.priceComparison?.notice).toStartWith("Total returns in each listing's currency; cash distributions reinvested at the ex-date close");
    expect(result.warnings.join(" ")).not.toContain("distribution history unavailable");

    // One listing whose history cannot be read stays a price return, says so, and the other still reinvests.
    const partial = await resolveChartSpecData(chart, withActions(async (symbol) => {
      if (symbol === "NEWER") throw new Error("no history");
      return actions(symbol);
    }));
    expect(partial.series.map((entry) => entry.returnBasis)).toEqual(["total", "price"]);
    expect(partial.series.map((entry) => entry.points.at(-1)?.value)).toEqual([0, 10]);
    expect(partial.priceComparison?.notice).toContain("Price return for NEWER: distribution history unavailable.");
    expect(partial.warnings).toContain("NEWER:XNAS: distribution history unavailable; showing the price return.");

    // On the raw price axis it is no comparison, and the levels still say they include reinvested cash.
    const rawAxis = { ...chart, series: chart.series.map((entry) => ({ ...entry, transform: "raw" as const })) };
    const levels = await resolveChartSpecData(rawAxis, withActions(async (symbol) => actions(symbol)));
    expect(levels.priceComparison).toBeUndefined();
    expect(levels.returnBasisNotice).toStartWith("Total return levels in each listing's currency: prices include cash distributions reinvested at the ex-date close");
    expect(levels.warnings).toContain(levels.returnBasisNotice!);
    expect(levels.series[0]!.points.at(-1)!.value).toBeCloseTo(100, 6);

    // The default comparison stays a price return and asks no one for cash.
    let asked = 0;
    const price = await resolveChartSpecData(spec(), withActions(async (symbol) => { asked += 1; return actions(symbol); }));
    expect(asked).toBe(0);
    expect(price.series.every((entry) => entry.returnBasis === undefined)).toBe(true);
    expect(price.priceComparison?.notice).toStartWith("Price returns in each listing's currency");
    expect(price.returnBasisNotice).toBeUndefined();
  });

  test("a panned comparison keeps loaded bars past both edges of the view to pan into, and only shared dates inside it", async () => {
    const days = (from: string, count: number, skip: string[] = []) => Array.from({ length: count }, (_, index) => (
      new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10)
    )).filter((day) => !skip.includes(day));
    // The second listing has no bar on the view's last day.
    const data = {
      OLDER: rows(days("2026-07-01", 70).map((day, index) => [day, 100 + index])),
      NEWER: rows(days("2026-07-01", 70, ["2026-08-28"]).map((day, index) => [day, 50 + index])),
    };
    const view = { start: date("2026-08-17"), end: date("2026-08-28T23:59:59.999Z") };
    const result = await resolveChartSpecData(spec(), sources(data), new ChartResolveCache(), { requestViewport: view });
    const span = (points: { date: Date }[]) => [points[0]?.date.toISOString().slice(0, 10), points.at(-1)?.date.toISOString().slice(0, 10)];
    expect(result.series.map((entry) => span(entry.points))).toEqual([["2026-08-17", "2026-08-27"], ["2026-08-17", "2026-08-27"]]);
    for (const [index, buffered] of result.bufferedSeries!.entries()) {
      expect(buffered.points[0]!.date.getTime()).toBeLessThan(view.start.getTime());
      expect(buffered.points.at(-1)!.date.getTime()).toBeGreaterThan(view.end.getTime());
      const inView = buffered.points.filter((point) => point.date >= view.start && point.date <= view.end);
      expect(inView).toEqual(result.series[index]!.points);
    }
  });

  test("a weekly comparison's notice dates its shared bars by their last sessions, a daily one by their dates", async () => {
    // Thu 10 Sep 2026 18:00 UTC, as the sources read it: New York is trading, so the week of Mon 7 Sep runs through today.
    setSystemTime(date("2026-09-10T18:00:00Z"));
    try {
      expect((await resolveChartSpecData(spec("1d"), sources())).priceComparison?.notice)
        .toContain("From Mon 2 May 2022 close to Mon 7 Sep close;");
      // The week of Mon 2 May 2022 closed on Fri 6 May; this week runs through today's session.
      expect((await resolveChartSpecData(spec("1wk"), sources())).priceComparison?.notice)
        .toContain("From Fri 6 May 2022 close to Thu 10 Sep, latest, intraday;");
    } finally {
      setSystemTime();
    }
  });

  test("missing holiday dates use an exact overlap without carrying or rounding observations", async () => {
    const result = await resolveChartSpecData(spec(), sources({
      OLDER: rows([["2026-09-04", 10], ["2026-09-07", 15], ["2026-09-08", 20], ["2026-09-09", 30], ["2026-09-10", 40]]),
      NEWER: rows([["2026-09-08", 100], ["2026-09-10", 300]]),
    }));
    expect(result.priceComparison).toMatchObject({ start: Date.parse("2026-09-08"), end: Date.parse("2026-09-10") });
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([100, 200]);
    expect(result.series.map((s) => s.points.length)).toEqual([3, 2]);
    const shifted = result.series.map((s, index) => ({ ...s, points: s.points.map((p) => ({ ...p, date: new Date(p.date.getTime() + index * 1_000) })) }));
    expect(resolvePriceComparison(spec(), shifted, { start: null, end: null }, "1m")?.start).toBeNull();
  });

  test("daily comparisons align market dates while preserving exact source timestamps and endpoints", async () => {
    const chart = spec();
    chart.series[0]!.source = { kind: "security", instrument: { symbol: "OLDER", exchange: "CCC" }, fieldId: "market.close" };
    const data = {
      OLDER: rows([["2026-09-07", 80], ["2026-09-08", 100], ["2026-09-09", 110], ["2026-09-10", 200]]),
      NEWER: rows([["2026-09-08T13:30:00Z", 50], ["2026-09-09T13:30:00Z", 60]]),
    };
    const result = await resolveChartSpecData(chart, sources(data));
    expect(result.priceComparison).toMatchObject({ alignment: "session-date", sourceBounds: {
      OLDER: { start: Date.parse("2026-09-08"), end: Date.parse("2026-09-09") },
      NEWER: { start: Date.parse("2026-09-08T13:30:00Z"), end: Date.parse("2026-09-09T13:30:00Z") },
    } });
    for (const collection of [result.series, result.bufferedSeries!, result.legendSeries!]) {
      expect(collection.map((entry) => entry.points.map((point) => point.value))).toEqual([[0, 10], [0, 20]]);
      expect(collection[0]!.points.at(-1)!.date.toISOString()).toBe("2026-09-09T00:00:00.000Z");
      expect(collection[1]!.points[0]!.date.toISOString()).toBe("2026-09-08T13:30:00.000Z");
    }
    expect(summarizeResolvedSeries(result.series[1]!)).toMatchObject({ startValue: 50, endValue: 60, return: 0.2 });
    const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), data[entry.id as keyof typeof data]])));
    expect(seeded?.series.map((entry) => entry.points.at(-1)?.value)).toEqual([10, 20]);
    expect(data.OLDER.at(-1)?.close).toBe(200);
  });

  test("session dates handle venues opening on the preceding UTC day", async () => {
    const chart = spec();
    chart.series[1]!.source = { kind: "security", instrument: { symbol: "NEWER", exchange: "ASX" }, fieldId: "market.close" };
    const result = await resolveChartSpecData(chart, sources({
      OLDER: rows([["2026-01-08T14:30:00Z", 10], ["2026-01-09T14:30:00Z", 12]]),
      NEWER: rows([["2026-01-07T23:00:00Z", 20], ["2026-01-08T23:00:00Z", 30]]),
    }));
    expect(result.series.map((entry) => entry.points.at(-1)?.value)).toEqual([20, 50]);
    // In summer Sydney's opening bar starts on the previous UTC date.
    expect(result.priceComparison?.sourceBounds?.NEWER.start).toBe(Date.parse("2026-01-07T23:00:00Z"));
  });

  test("Auto cached and network comparisons use the same effective calendar resolution", async () => {
    const chart = spec();
    chart.viewport = { range: "1Y", resolution: "auto" };
    chart.series[0]!.source = { kind: "security", instrument: { symbol: "OLDER", exchange: "CCC" }, fieldId: "market.close" };
    const data = {
      OLDER: rows([["2026-09-08", 100], ["2026-09-09", 110]]),
      NEWER: rows([["2026-09-08T13:30:00Z", 50], ["2026-09-09T13:30:00Z", 60]]),
    };
    const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), data[entry.id as keyof typeof data]])), sources(data).now);
    const network = await resolveChartSpecData(chart, sources(data));
    expect(seeded?.resolution).toBe("1d");
    expect(seeded?.resolution).toBe(network.resolution);
    expect(seeded?.priceComparison).toEqual(network.priceComparison);
    expect(seeded?.series.map((entry) => entry.points.map((point) => point.value))).toEqual([[0, 10], [0, 20]]);
  });

  test("date-only windows include prior-UTC sessions but timestamp navigation remains exact", async () => {
    const chart = spec();
    chart.viewport.dateWindow = { start: "2026-01-08", end: "2026-01-09" };
    chart.series[0]!.source = { kind: "security", instrument: { symbol: "OLDER", exchange: "ASX" }, fieldId: "market.close" };
    const data = {
      OLDER: rows([["2026-01-06T23:00:00Z", 90], ["2026-01-07T23:00:00Z", 100], ["2026-01-08T23:00:00Z", 110], ["2026-01-09T23:00:00Z", 150]]),
      NEWER: rows([["2026-01-07T14:30:00Z", 30], ["2026-01-08T14:30:00Z", 50], ["2026-01-09T14:30:00Z", 60], ["2026-01-10T14:30:00Z", 90]]),
    };
    chart.studies = [{ id: "sma", kind: "sma", inputSeriesIds: ["OLDER"], parameters: { period: 2 }, panelId: "main", axis: "left" }];
    const network = await resolveChartSpecData(chart, sources(data));
    const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), data[entry.id as keyof typeof data]])));
    for (const result of [network, seeded!]) {
      // Measured from the close before the window, 7 Jan's on both venues (Sydney's opens on 6 Jan UTC).
      expect(result.series.slice(0, 2).map((entry) => entry.points.map((point) => point.value))).toEqual([[0, 11.11111111111111, 22.22222222222222], [0, 66.66666666666666, 100]]);
      expect(result.viewport?.start.toISOString()).toBe("2026-01-06T23:00:00.000Z");
      expect(result.viewport?.end.toISOString()).toBe("2026-01-09T23:59:59.999Z");
      expect(result.series.find((entry) => entry.id === "sma")?.points.map((point) => [point.rawValue, point.value])).toEqual([[95, 5.555555555555555], [105, 16.666666666666664]]);
    }
    expect(chart.viewport.dateWindow).toEqual({ start: "2026-01-08", end: "2026-01-09" });
    const requestViewport = { start: date("2026-01-08"), end: date("2026-01-09T23:59:59.999Z") };
    const panned = await resolveChartSpecData(chart, sources(data), new ChartResolveCache(), { requestViewport });
    expect(panned.priceComparison?.start).toBeNull();
    expect(panned.viewport).toEqual(requestViewport);
    chart.viewport.dateWindow = { start: requestViewport.start.toISOString(), end: requestViewport.end.toISOString() };
    const timestamped = await resolveChartSpecData(chart, sources(data));
    expect(timestamped.priceComparison?.start).toBeNull();
  });

  test("price overlays normalize against their own compared input rather than the global timestamp envelope", async () => {
    const chart = spec();
    chart.viewport.dateWindow = { start: "2026-01-08", end: "2026-01-09" };
    chart.series[0]!.source = { kind: "security", instrument: { symbol: "OLDER", exchange: "NZX" }, fieldId: "market.close" };
    chart.studies = [{ id: "sma", kind: "sma", inputSeriesIds: ["NEWER"], parameters: { period: 2 }, panelId: "main", axis: "left" }];
    const result = await resolveChartSpecData(chart, sources({
      OLDER: rows([["2026-01-07T21:00:00Z", 100], ["2026-01-08T21:00:00Z", 110]]),
      NEWER: rows([["2026-01-07T21:00:00Z", 30], ["2026-01-08T21:00:00Z", 50], ["2026-01-09T21:00:00Z", 60]]),
    }));
    expect(result.series.find((entry) => entry.id === "sma")?.points.map((point) => [point.rawValue, point.value])).toEqual([[40, -20], [55, 10]]);
    expect(result.series[1]!.points.map((point) => point.value)).toEqual([0, 20]);
  });

  test("one-leg streamed and snapshot quotes cannot rewrite a shared weekly source bar", async () => {
    const compared = spec("1wk");
    const inputs = sources();
    const quote: Quote = { symbol: "NEWER", currency: "USD", price: 900, change: 0, changePercent: 99, lastUpdated: inputs.now.getTime(), marketState: "REGULAR" };
    inputs.dataProvider.getTickerFinancials = async (symbol) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: histories[symbol as keyof typeof histories], quote });
    // Bare listings also load financials with a snapshot quote.
    for (const s of compared.series) if (s.source.kind === "security") delete s.source.instrument.exchange;
    const result = await resolveChartSpecData(compared, { ...inputs, quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(compared.series[1]!.source), quote]]) });
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
    expect(result.series.map((s) => s.points.at(-1)?.rawValue)).toEqual([180, 60]);
  });

  test("a preset range measures each leg from its close on or before the same date a range before, and to its own newest close", async () => {
    const weekdays = (to: string) => {
      const out: [string, number][] = [];
      for (let time = Date.parse("2026-07-01"); time <= Date.parse(to); time += 86_400_000) {
        if (![0, 6].includes(new Date(time).getUTCDay())) out.push([new Date(time).toISOString().slice(0, 10), 100 + out.length]);
      }
      return out;
    };
    // NEWER's saved copy stops on Fri 16 Oct; OLDER trades on Tue 20 Oct, whose session is open.
    const data = { OLDER: weekdays("2026-10-20"), NEWER: weekdays("2026-10-16") };
    const chart: ChartSpec = { ...spec(), viewport: { range: "1M", resolution: "1d" } };
    const result = await resolveChartSpecData(chart, { ...sources({ OLDER: rows(data.OLDER), NEWER: rows(data.NEWER) }), now: date("2026-10-20T18:00:00Z") });
    // A month before Tue 20 Oct is Sun 20 Sep: both legs run from Fri 18 Sep's close, and NEWER does not cut OLDER short.
    expect(result.priceComparison?.legs).toEqual({
      OLDER: { baseDay: "2026-09-18", endDay: "2026-10-20", intraday: true },
      NEWER: { baseDay: "2026-09-18", endDay: "2026-10-16", intraday: false },
    });
    expect(result.priceComparison?.notice).toContain("From Fri 18 Sep close to Tue 20 Oct, latest, intraday (NEWER Fri 16 Oct close);");
    const close = (leg: [string, number][], day: string) => leg.find(([key]) => key === day)![1];
    expect(result.series[0]!.points.at(-1)!.value!).toBeCloseTo((close(data.OLDER, "2026-10-20") / close(data.OLDER, "2026-09-18") - 1) * 100, 10);
    expect(result.series[1]!.points.at(-1)!.value!).toBeCloseTo((close(data.NEWER, "2026-10-16") / close(data.NEWER, "2026-09-18") - 1) * 100, 10);
  });

  test("a leg that is not a ticker is left out, named as asked and pointed at its index, not by its id", async () => {
    const chart = spec();
    chart.series[1] = { ...chart.series[1]!, id: "vix-market-close-3", source: { kind: "security", instrument: { symbol: "VIX" }, fieldId: "market.close" } };
    const inputs = sources();
    const fail = async (symbol: string) => {
      if (symbol === "VIX") throw new Error("Not a ticker: VIX.");
      return histories.OLDER;
    };
    Object.assign(inputs.dataProvider, { getPriceHistory: fail, getPriceHistoryForResolution: fail, getDetailedPriceHistory: fail,
      getTickerFinancials: async (symbol: string) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: await fail(symbol) }) });
    const result = await resolveChartSpecData(chart, inputs);
    expect(result.errors).toEqual(["VIX: Not a ticker: VIX. Did you mean ^VIX (Cboe Volatility Index)?"]);
    expect(result.priceComparison?.dropped?.map((entry) => entry.label)).toEqual(["VIX"]);
    expect(result.priceComparison?.notice).toEndWith("Left out: VIX.");
    // OLDER compares on its own, from its first close in the window (100 to 200).
    expect(result.series[0]?.points.at(-1)?.value).toBe(100);
  });

  test("disjoint and single-overlap history leave comparison unavailable, then recover from the source", async () => {
    for (const newer of [rows([["2026-09-10", 60]]), rows([["2025-01-02", 60], ["2025-01-03", 65]])]) {
      const result = await resolveChartSpecData(spec(), sources({ ...histories, NEWER: newer }));
      expect(result.priceComparison).toMatchObject({ start: null, end: null });
      expect(result.series.every((s) => s.points.length === 0)).toBe(true);
      expect(result.bufferedSeries?.every((s) => s.points.length === 0)).toBe(true);
    }
    const partialSeed = seedChartResolutionResult(spec(), new Map([[chartQuoteOverrideKeyForSource(spec().series[0]!.source), histories.OLDER]]));
    expect(partialSeed?.series[0]?.points).toEqual([]);
    const recovered = await resolveChartSpecData(spec(), sources());
    expect(recovered.series[0]?.points.at(-1)?.value).toBe(125);
  });

  test("a legitimate zero endpoint is -100%; a zero baseline is never divided", async () => {
    const result = await resolveChartSpecData(spec(), sources({
      OLDER: rows([["2026-09-07", 0], ["2026-09-08", 10], ["2026-09-10", 0]]),
      NEWER: rows([["2026-09-07", 50], ["2026-09-08", 100], ["2026-09-10", 200]]),
    }));
    expect(result.priceComparison?.start).toBe(Date.parse("2026-09-08"));
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([-100, 100]);
  });

  test("index100 shares dates while price studies still calculate from raw buffered observations", async () => {
    const indexed = spec();
    indexed.series.forEach((s) => { s.transform = "index100"; });
    indexed.studies = [
      { id: "sma", kind: "sma", inputSeriesIds: ["OLDER"], parameters: { period: 2 }, panelId: "main", axis: "left" },
      { id: "ratio", kind: "ratio", inputSeriesIds: ["OLDER", "NEWER"], parameters: {}, panelId: "ratio", axis: "left" },
    ];
    const result = await resolveChartSpecData(indexed, sources());
    expect(result.series.slice(0, 2).map((s) => s.points.at(-1)?.value)).toEqual([225, 120]);
    const sma = result.series.find((s) => s.id === "sma")!;
    const firstCommon = sma.points.find((p) => p.date.getTime() === Date.parse("2022-05-02"))!;
    expect(firstCommon.rawValue).toBe(90);
    expect(firstCommon.value).toBe(112.5);
    expect(result.series.find((s) => s.id === "ratio")?.points.at(-1)?.value).toBe(200 / 60);
  });

  test("explicit/panned windows recompute shared baselines while raw, mixed and period-limited charts retain their meaning", async () => {
    const selected = spec();
    selected.viewport.dateWindow!.start = "2022-05-09";
    const cache = new ChartResolveCache();
    const result = await resolveChartSpecData(selected, sources(), cache);
    // Authored dates measure from the close the legs share before the first date, as RETURN does: 2 May's.
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([125, 20]);
    expect(result.priceComparison?.notice).toContain("From Mon 2 May 2022 close");
    const panned = await resolveChartSpecData(selected, sources(), cache, { requestViewport: { start: date("2026-09-07"), end: date("2026-09-10") } });
    expect(panned.priceComparison?.start).toBeNull();
    const raw = spec();
    raw.series.forEach((s) => { s.transform = "raw"; });
    const rawResult = await resolveChartSpecData(raw, sources());
    expect(rawResult.priceComparison).toBeUndefined();
    expect(rawResult.series.map((s) => s.points[0]?.value)).toEqual([100, 50]);
    expect(rawResult.series.map((s) => s.points.at(-1)?.value)).toEqual([200, 60]);
    const mixed = spec();
    mixed.series[1]!.source = { kind: "economic", provider: "fred", seriesId: "GDP" };
    expect(resolvePriceComparison(mixed, rawResult.series, { start: null, end: null })).toBeNull();
    const limited = spec(); limited.viewport.maxPoints = 2;
    expect(resolvePriceComparison(limited, rawResult.series, { start: null, end: null })).toBeNull();
  });

  test("a window in monthly bars is measured from the close of the month it starts in, as --from 2019-12-31 asks", async () => {
    // `fn CMP IAG:LSE LHA:XETRA --from 2019-12-31` comes back in monthly bars, dated by each month's 1st: the
    // December bar's close is 31 Dec 2019's, and the comparison is measured from it, not from January's.
    const monthly = (closes: number[]) => rows(closes.map((close, index) => [`20${19 + Math.floor((index + 11) / 12)}-${String((index + 11) % 12 + 1).padStart(2, "0")}-01`, close]));
    const window = spec("1d");
    window.viewport = { range: "ALL", resolution: "1mo", dateWindow: { start: "2019-12-31", end: "2020-03-31" } };
    const result = await resolveChartSpecData(window, sources({ OLDER: monthly([100, 80, 50, 40]), NEWER: monthly([10, 9, 6, 5]) }));
    expect(result.priceComparison?.notice).toContain("From Tue 31 Dec 2019 close");
    expect(result.series.map((s) => s.points.at(-1)?.value)).toEqual([-60, -50]);
  });
});

describe("a fund compared with a coin", () => {
  const HOUR = 60 * 60_000;
  // IBIT's daily closes and BTC-USD's UTC-day closes, Mon 19 to Fri 23 Oct 2026; the US session closes 20:00 UTC.
  const days = ["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
  const fund = rows(days.map((day, index) => [day, 50 + index]));
  const coinDaily = rows(days.map((day, index) => [day, 100_000 + index * 1_000]));
  // Hourly coin bars by open time: the one opening 19:00 UTC closes at the US close, at 90k plus 2k a day.
  const coinHourly = (from: string, to: string): PricePoint[] => {
    const points: PricePoint[] = [];
    for (let time = Date.parse(from); time < Date.parse(to); time += HOUR) {
      const day = days.indexOf(new Date(time).toISOString().slice(0, 10));
      const atUsClose = new Date(time).getUTCHours() === 19;
      points.push({ date: new Date(time), close: atUsClose && day >= 0 ? 90_000 + day * 2_000 : 95_000 });
    }
    return points;
  };
  function chart(window: { start: string; end: string }, resolution: "1d" | "1h" = "1d"): ChartSpec {
    return {
      version: CHART_SPEC_VERSION,
      viewport: { range: "1M", resolution, dateWindow: window },
      panels: [{ id: "main" }], studies: [],
      series: [["IBIT", "NASDAQ"], ["BTC-USD", "CCC"]].map(([symbol, exchange]) => ({
        id: symbol!, source: { kind: "security", instrument: { symbol: symbol!, exchange: exchange! }, fieldId: "market.close" },
        style: "line", transform: "percent", axis: "left", panelId: "main", interpolation: "none",
      })),
    };
  }
  function coinSources(hourly: (from: string, to: string) => PricePoint[] = coinHourly, intraday?: Record<string, PricePoint[]>) {
    const daily: Record<string, PricePoint[]> = { IBIT: fund, "BTC-USD": coinDaily };
    const history = async (symbol: string) => (intraday ?? daily)[symbol] ?? [];
    return {
      now: date("2026-10-30T22:00:00Z"),
      dataProvider: createTestDataProvider({
        getQuote: async (symbol) => ({ symbol, currency: "USD", price: 1, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-10-30T22:00:00Z") }),
        getTickerFinancials: async (symbol) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: daily[symbol] ?? [] }),
        getPriceHistory: history,
        getPriceHistoryForResolution: history,
        getDetailedPriceHistoryWithMetadata: async (symbol, _exchange, start, end) => ({
          points: intraday?.[symbol] ?? (symbol === "BTC-USD" ? hourly(start.toISOString(), end.toISOString()) : []), resolution: "1h" as const,
        }),
      }),
      loadFredSeries: async () => ({ data: { observations: [], info: null }, fetchedAt: 0, stale: false, source: "network" as const }),
    };
  }

  test("the coin is measured at the fund's close when its hourly bars reach both ends, and the notice says so", async () => {
    const result = await resolveChartSpecData(chart({ start: "2026-10-19", end: "2026-10-23" }), coinSources());
    expect(result.priceComparison?.notice).toContain("BTC-USD at the US close");
    // From Fri 16 Oct's 20:00 UTC price (90k) to Fri 23 Oct's (100k), not the UTC-day closes (100k to 105k).
    expect(result.series.map((entry) => entry.points.at(-1)?.value)).toEqual([10, 100 / 9]);
  });

  test("without hourly bars the coin keeps its UTC close, and the notice names both close times", async () => {
    const result = await resolveChartSpecData(chart({ start: "2026-10-19", end: "2026-10-23" }), coinSources(() => []));
    expect(result.priceComparison?.notice).toContain("BTC-USD to 00:00 UTC, 4 h after the US close");
    expect(result.series.map((entry) => entry.points.at(-1)?.value)).toEqual([10, 5]);
  });

  test("an explicit --from is measured from the close before that date, as RETURN is", async () => {
    const result = await resolveChartSpecData(chart({ start: "2026-10-19", end: "2026-10-23" }), coinSources(() => []));
    expect(result.priceComparison?.notice).toContain("From Fri 16 Oct close");
    expect(result.series[0]!.points[0]).toMatchObject({ value: 0, rawValue: 50 });
  });

  test("hourly legs stamped at different minutes are matched by the hour; legs that never share one name the bar that compares them", async () => {
    // IBIT's hourly bars open on the half hour, BTC-USD's on the hour.
    const fundHours = rows([["2026-10-29T13:30:00Z", 50], ["2026-10-29T14:30:00Z", 51], ["2026-10-29T15:30:00Z", 55]]);
    const coinHours = rows([["2026-10-29T13:00:00Z", 100], ["2026-10-29T14:00:00Z", 104], ["2026-10-29T15:00:00Z", 110]]);
    const window = { start: "2026-10-29", end: "2026-10-29" };
    const matched = await resolveChartSpecData(chart(window, "1h"), coinSources(coinHourly, { IBIT: fundHours, "BTC-USD": coinHours }));
    expect(matched.series.map((entry) => entry.points.at(-1)?.value)).toEqual([10, 10]);
    const apart = await resolveChartSpecData(chart(window, "1h"), coinSources(coinHourly, {
      IBIT: fundHours, "BTC-USD": rows([["2026-10-29T03:00:00Z", 100], ["2026-10-29T04:00:00Z", 104]]),
    }));
    expect(apart.priceComparison?.notice).toContain("IBIT and BTC-USD share no 1H bar times in this range; daily bars (1D) compare them.");
  });
});
