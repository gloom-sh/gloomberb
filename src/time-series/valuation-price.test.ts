import { expect, spyOn, test } from "bun:test";
import type { TickerFinancials } from "../types/financials";
import { createTestDataProvider } from "../test-support/data-provider";
import { createDefaultConfig } from "../types/config";
import { loadChartPaneModel } from "../plugins/builtin/chart-composer/headless";
import { extractFundamentalSeries, valuationPriceIssues } from "./fundamentals";
import { resolveStudies } from "./studies";
import { resolveChartSpecData } from "./resolve";
import { chartQuoteOverrideKeyForSource, subscribeToLiveChartQuotes } from "./live-quotes";
import { CHART_SPEC_VERSION, type ChartSpec, type SecuritySeriesSource } from "./types";

const source = (metric = "trailingPE"): SecuritySeriesSource => ({ kind: "security",
  instrument: { symbol: "TEST", exchange: "NYSE" }, fieldId: `valuation.${metric}`,
  period: "annual", timestampMode: "available-at" });
const fixture = (): TickerFinancials => ({ financialCurrency: "USD",
  quote: { symbol: "TEST", currency: "USD", price: 60, change: 0, changePercent: 0,
    lastUpdated: Date.parse("2026-09-11T20:00:00Z") },
  annualStatements: [{ date: "2025-12-31", availableAt: "2026-09-10T14:00:00Z", currency: "USD",
    eps: 10, totalRevenue: 100, dilutedShares: 10, totalDebt: 20, cashAndCashEquivalents: 5,
    ebitda: 30, freeCashFlow: 20 }], quarterlyStatements: [],
  priceHistory: [{ date: new Date("2026-09-09"), close: 50 },
    { date: new Date("2026-09-10T13:30:00Z"), open: 54, high: 56, low: 53, close: 55 }],
});
const fields = ["trailingPE", "priceSales", "evSales", "evEbitda", "priceFcf"];

test("stale quote-derived Current multiples are withheld while historical ratios and input evidence survive", () => {
  const data = fixture();
  const history = fields.map((field) => extractFundamentalSeries(data, source(field))[0]);
  data.quote!.stale = true;
  const original = JSON.stringify(data);
  fields.forEach((field, index) => {
    expect(extractFundamentalSeries(data, source(field))).toEqual([history[index]!]);
    expect(valuationPriceIssues(data, source(field))).toEqual([expect.objectContaining({ kind: "quote", reason: "stale",
      quote: expect.objectContaining({ price: 60, lastUpdated: data.quote!.lastUpdated, stale: true }) })]);
  });
  expect(JSON.stringify(data)).toBe(original);
  data.quote!.stale = false;
  for (const field of fields) expect(extractFundamentalSeries(data, source(field)).at(-1)?.periodLabel).toBe("Current");
});

test("invalid current quote price or timestamp never borrows the historical close", () => {
  for (const patch of [{ price: NaN }, { price: Infinity }, { price: 0 }, { price: -1 },
    { lastUpdated: NaN }, { lastUpdated: 0 }, { lastUpdated: -1 }, { lastUpdated: 9e20 }]) {
    const data = fixture(); Object.assign(data.quote!, patch);
    const points = extractFundamentalSeries(data, source());
    expect(points.map((point) => point.value)).toEqual([5.5]);
    expect(points.some((point) => point.periodLabel === "Current")).toBe(false);
    expect(valuationPriceIssues(data, source())[0]?.kind).toBe("quote");
  }
  const afterHours = fixture(); Object.assign(afterHours.quote!, { high: 58, low: 53, price: 60 });
  expect(extractFundamentalSeries(afterHours, source()).at(-1)?.value).toBe(6);
  expect(valuationPriceIssues(afterHours, source())).toEqual([]);
});

test("a latest contradictory historical bar leaves a diagnostic gap instead of using its close or an older bar", () => {
  const data = fixture(); data.quote!.stale = true;
  data.priceHistory[1]!.open = 70;
  const original = JSON.stringify(data.priceHistory);
  for (const field of fields) {
    const points = extractFundamentalSeries(data, source(field));
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBeNull();
    expect(points[0]?.observedAt.toISOString()).toBe("2025-12-31T00:00:00.000Z");
    expect(points[0]?.provenance?.priceHistoryIntegrity?.sourcePoints[0]).toMatchObject({ open: 70, high: 56, close: 55 });
  }
  expect(JSON.stringify(data.priceHistory)).toBe(original);
  // A valid close-only row at the same time cannot erase contradictory evidence.
  data.priceHistory.push({ date: data.priceHistory[1]!.date, close: 55 });
  expect(extractFundamentalSeries(data, source())[0]?.value).toBeNull();
  data.priceHistory.reverse();
  expect(extractFundamentalSeries(data, source())[0]?.value).toBeNull();
  // A genuinely newer valid observation before availability restores the ratio.
  data.priceHistory.push({ date: new Date("2026-09-10T13:45:00Z"), close: 57 });
  expect(extractFundamentalSeries(data, source())[0]?.value).toBe(5.7);
  // Removing the corrupt source through a corrected input also restores it.
  data.priceHistory = [{ date: new Date("2026-09-10T13:30:00Z"), close: 55 }];
  expect(extractFundamentalSeries(data, source())[0]?.value).toBe(5.5);
});

test("later corruption and invalid dates cannot change an earlier valuation; serialized history remains supported", () => {
  const data = fixture(); data.quote!.stale = true;
  data.priceHistory.push({ date: new Date("2026-09-11"), open: 100, high: 56, low: 50, close: 55 });
  data.priceHistory.push({ date: null as unknown as Date, close: 99 });
  data.priceHistory = JSON.parse(JSON.stringify(data.priceHistory));
  expect(extractFundamentalSeries(data, source())[0]?.value).toBe(5.5);
  expect(extractFundamentalSeries(data, source())[0]?.provenance?.priceHistoryIntegrity).toBeUndefined();
});

test("an unusable latest historical close does not silently fall back to an older quote", () => {
  for (const close of [0, -5, NaN, Infinity]) {
    const data = fixture(); data.quote = undefined;
    // Keep declared price units through a metadata-only quote.
    data.quote = { ...fixture().quote!, lastUpdated: 0 };
    data.priceHistory = [{ date: new Date("2026-09-09"), close: 50 },
      { date: new Date("2026-09-10"), close }];
    expect(extractFundamentalSeries(data, source())[0]?.value).toBeNull();
    expect(valuationPriceIssues(data, source())).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "history", reason: "invalid-price" }),
    ]));
  }
});

async function load(data: TickerFinancials, viewport: Partial<ChartSpec["viewport"]> = {}, studies: ChartSpec["studies"] = []) {
  const spec: ChartSpec = { version: CHART_SPEC_VERSION, viewport: { range: "5Y", resolution: "1d", ...viewport },
    panels: [{ id: "main" }], studies, series: [{ id: "pe", source: source(), style: "line",
      transform: "raw", axis: "left", panelId: "main", interpolation: "none" }] };
  return loadChartPaneModel(spec, { marketData: createTestDataProvider({ getTickerFinancials: async () => data,
    getPriceHistoryForResolution: async () => data.priceHistory, getQuote: async () => data.quote! }),
    config: createDefaultConfig("/tmp/valuation-price-test"), apiClient: {} as any, signal: new AbortController().signal });
}

test("actual resolver/export retain stale-source diagnostics and historical values, then recover on a fresh quote", async () => {
  const data = fixture(); data.quote!.stale = true;
  const model = await load(data);
  expect(model.series[0]?.points.map((point) => point.value)).toEqual([5.5]);
  expect(model.complete).toBe(false);
  expect(model.metadata?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("source quote is stale")]));
  expect(model.metadata?.valuationPriceIssues).toEqual([expect.objectContaining({ seriesId: "pe", issues: [
    expect.objectContaining({ reason: "stale", quote: expect.objectContaining({ price: 60, lastUpdated: data.quote!.lastUpdated, stale: true }) }),
  ] })]);
  expect(model.snapshot.financials[0]?.[1].quote?.stale).toBe(true);
  data.quote!.stale = false;
  const recovered = await load(data);
  expect(recovered.series[0]?.points.at(-1)?.value).toBe(6);
  expect(recovered.metadata?.valuationPriceIssues).toBeUndefined();
  expect(recovered.complete).not.toBe(false);
});

test("future Current quote times retain invalid-time provenance without changing historical multiples", async () => {
  const now = Date.parse("2026-09-12T04:00:00Z");
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const data = fixture();
  const future = now + 86_400_000;
  data.quote!.lastUpdated = future;
  const original = JSON.stringify(data);
  try {
    for (const field of fields) {
      expect(extractFundamentalSeries(data, source(field)).some(point => point.periodLabel === "Current")).toBe(false);
      expect(valuationPriceIssues(data, source(field))).toEqual([expect.objectContaining({ reason: "invalid-timestamp", quote: expect.objectContaining({ lastUpdated: future, price: 60 }) })]);
    }
    const model = await load(data);
    expect(model.series[0]?.points.map(point => point.value)).toEqual([5.5]);
    expect(model.complete).toBe(false);
    expect(model.metadata?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("source quote timestamp is unavailable")]));
    expect(model.metadata?.valuationPriceIssues).toEqual([expect.objectContaining({ issues: [expect.objectContaining({ reason: "invalid-timestamp", quote: expect.objectContaining({ lastUpdated: future }) })] })]);
    expect(JSON.stringify(data)).toBe(original);
    for (const viewport of [{ dateWindow: { start: "2026-09-10T13:00:00Z", end: "2026-09-10T20:00:00Z" } }, { maxPoints: 1 }]) {
      const historical = await load(data, viewport);
      expect(historical.complete).not.toBe(false);
      expect(historical.metadata?.valuationPriceIssues).toBeUndefined();
    }
    data.quote!.lastUpdated = now - 60_000;
    const recovered = await load(data);
    expect(recovered.series[0]?.points.at(-1)).toMatchObject({ periodLabel: "Current", value: 6 });
    expect(recovered.metadata?.valuationPriceIssues).toBeUndefined();
    expect(recovered.complete).not.toBe(false);
  } finally { clock.mockRestore(); }
});

test("actual resolver/export count a null corrupt valuation as unavailable and retain the original candle", async () => {
  const data = fixture(); data.quote!.stale = true; data.priceHistory[1]!.open = 70;
  const model = await load(data);
  expect(model.complete).toBe(false);
  expect(model.unavailableSymbols).toEqual(["TEST:XNYS"]);
  expect(model.metadata?.priceHistoryIntegrity).toEqual(expect.arrayContaining([
    expect.objectContaining({ seriesId: "pe", integrity: expect.objectContaining({ sourcePoints: [expect.objectContaining({ open: 70, high: 56 })] }) }),
  ]));
  expect(model.metadata?.summaries).toEqual(expect.arrayContaining([expect.objectContaining({ endValue: null })]));
  expect(model.metadata?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("inconsistent OHLC")]));
});

test("historical date windows and period limits do not inherit excluded current or older price failures", async () => {
  const data = fixture(); data.quote!.stale = true;
  for (const viewport of [{ dateWindow: { start: "2026-09-10T13:00:00Z", end: "2026-09-10T20:00:00Z" } }, { maxPoints: 1 }]) {
    const model = await load(data, viewport);
    expect(model.series[0]?.points.map((point) => point.value)).toEqual([5.5]);
    expect(model.complete).not.toBe(false);
    expect(model.metadata?.valuationPriceIssues).toBeUndefined();
    expect(model.chart.warnings.some((warning) => warning.includes("source quote"))).toBe(false);
  }
  data.annualStatements.unshift({ ...data.annualStatements[0]!, date: "2024-12-31", availableAt: "2025-03-01" });
  data.priceHistory.unshift({ date: new Date("2025-02-28"), close: 0 });
  const limited = await load(data, { maxPoints: 1 });
  expect(limited.series[0]?.points.map((point) => point.value)).toEqual([5.5]);
  expect(limited.complete).toBe(true);
  expect(limited.metadata?.valuationPriceIssues).toBeUndefined();
  data.quote!.lastUpdated = NaN;
  expect((await load(data, { dateWindow: { start: "2026-09-10T13:00:00Z", end: "2026-09-10T20:00:00Z" } })).complete).not.toBe(false);
});

test("all-missing requested periods retain their price evidence and remain unavailable", async () => {
  const data = fixture(); data.quote!.stale = true; data.priceHistory[1]!.open = 70;
  const model = await load(data, { maxPoints: 1 });
  expect(model.series[0]?.points.map((point) => point.value)).toEqual([null]);
  expect(model.complete).toBe(false);
  expect(model.unavailableSymbols).toEqual(["TEST:XNYS"]);
  expect(model.metadata?.priceHistoryIntegrity).toEqual(expect.arrayContaining([
    expect.objectContaining({ integrity: expect.objectContaining({ sourcePoints: [expect.objectContaining({ open: 70 })] }) }),
  ]));
  expect(model.metadata?.valuationPriceIssues).toBeUndefined(); // Current was not requested.
});

test("invalid non-OHLC prices interrupt studies and retain the reason during later warmup", async () => {
  const data = fixture(); data.quote!.stale = true;
  data.annualStatements = [2023, 2024, 2025, 2026].map((year) => ({ date: `${year}-12-31`, availableAt: `${year + 1}-03-01`, currency: "USD", eps: 10 }));
  data.priceHistory = [50, 0, 70, 80].map((close, index) => ({ date: new Date(`${2024 + index}-03-01`), close }));
  const points = extractFundamentalSeries(data, source());
  expect(points.map((point) => point.value)).toEqual([5, null, 7, 8]);
  const study: ChartSpec["studies"][number] = { id: "sma", kind: "sma", inputSeriesIds: ["pe"], parameters: { period: 2 }, panelId: "main", axis: "left" };
  const outputs = resolveStudies([{ id: "pe", label: "P/E", color: "#fff", unit: "x", unitGroup: "ratio", nativeFrequency: "annual",
    dataShape: "scalar", style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none", points }], [study]);
  expect(outputs.series[0]?.points.map((point) => point.value)).toEqual([null, null, 7.5]);
  const warmup = await load(data, { dateWindow: { start: "2026-03-01", end: "2026-03-02" } }, [study]);
  expect(warmup.series.find((entry) => entry.id === "sma")?.points[0]?.value).toBeNull();
  expect(warmup.complete).toBe(false);
  expect(warmup.metadata?.valuationPriceIssues).toEqual(expect.arrayContaining([
    expect.objectContaining({ seriesId: "sma", issues: [expect.objectContaining({ kind: "history", reason: "invalid-price", point: expect.objectContaining({ close: 0 }) })] }),
  ]));
  expect(warmup.chart.warnings.some((warning) => warning.includes("Historical valuation unavailable"))).toBe(true);
  expect(warmup.chart.warnings.some((warning) => warning.includes("inconsistent OHLC"))).toBe(false);
});

test.each(["NaN", "future"] as const)("actual live quote status and %s timestamp recovery recompute Current valuations", async invalidKind => {
  const data = fixture();
  const spec: ChartSpec = { version: CHART_SPEC_VERSION, viewport: { range: "5Y", resolution: "1d" }, panels: [{ id: "main" }],
    studies: [], series: [{ id: "pe", source: source(), style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }] };
  let emit!: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[1];
  let target!: Parameters<NonNullable<ReturnType<typeof createTestDataProvider>["subscribeQuotes"]>>[0][number];
  const provider = createTestDataProvider({ getTickerFinancials: async () => data, getQuote: async () => data.quote!,
    getPriceHistoryForResolution: async () => data.priceHistory,
    subscribeQuotes: (targets, listener) => { target = targets[0]!; emit = listener; return () => {}; } });
  const results: Awaited<ReturnType<typeof resolveChartSpecData>>[] = [];
  const stop = subscribeToLiveChartQuotes({ spec, dataProvider: provider, refreshIntervalMs: 0,
    onRefresh: async (quoteOverrides) => { results.push(await resolveChartSpecData(spec, { dataProvider: provider,
      now: new Date("2026-09-12"), quoteOverrides })); } });
  async function waitForCount(count: number) {
    for (let tries = 0; tries < 100 && results.length < count; tries++) await Bun.sleep(2);
    expect(results).toHaveLength(count);
  }
  const valid = { ...data.quote!, stale: false };
  try {
    emit(target, { ...valid, lastUpdated: invalidKind === "NaN" ? NaN : Date.now() + 86_400_000, receivedAt: 1 });
    await waitForCount(1);
    // A valid timestamp must dislodge the malformed prior stream observation.
    emit(target, { ...valid, receivedAt: 2 });
    await waitForCount(2);
    expect(results.at(-1)?.series[0]?.points.at(-1)?.value).toBe(6);
    emit(target, { ...valid, stale: true, receivedAt: 3 });
    await waitForCount(3);
    expect(results.at(-1)?.series[0]?.points.map((point) => point.value)).toEqual([5.5]);
    expect(results.at(-1)?.warnings.some((warning) => warning.includes("source quote is stale"))).toBe(true);
    emit(target, { ...valid, stale: false, receivedAt: 4 });
    await waitForCount(4);
    expect(results.at(-1)?.series[0]?.points.at(-1)?.value).toBe(6);
    expect(results.at(-1)?.warnings.some((warning) => warning.includes("source quote is stale"))).toBe(false);
  } finally { stop(); }
  for (const invalid of [NaN, Infinity, 0, -1, 9e20, Date.now() + 86_400_000]) {
    data.quote!.lastUpdated = invalid;
    const recovered = await resolveChartSpecData(spec, { dataProvider: provider, now: new Date("2026-09-12"),
      quoteOverrides: new Map([[chartQuoteOverrideKeyForSource(source()), valid]]) });
    expect(recovered.series[0]?.points.at(-1)?.value).toBe(6);
    expect(recovered.series[0]?.valuationPriceIssues).toBeUndefined();
  }
});
