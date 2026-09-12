import { afterEach, expect, test } from "bun:test";
import { loadYahooEarningsCalendar } from "../../../sources/yahoo-finance/quote-summary";
import { mapYahooEarningsCalendarEvent } from "../../../sources/yahoo-finance/mappers";
import type { YahooQuoteSummaryResult } from "../../../sources/yahoo-finance/types";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachEarningsCalendarPersistence, loadEarningsCalendar, resetEarningsCalendarPersistence } from "./data/cache";
import { coherentEarningsValue, earningsEpsChange30d, earningsForecastPeriod } from "./estimate-basis";
import { projectEarningsCalendarHeadless } from "./headless";
import { buildEarningsColumns, renderEarningsCell } from "./table";
import { recordedEarnings } from "./estimate-fixtures.test-data";

const args = { argument: "SYN", rawArgument: "SYN", symbols: ["SYN"], options: { limit: 50 } };
afterEach(resetEarningsCalendarPersistence);
const fixtures = [
  ["SONY", "USD", "JPY", 0.33459],
  ["6758.T", "JPY", "JPY", 63.08788],
  ["BABA", "CNY", "CNY", 10.97892],
  ["9988.HK", "CNY", "CNY", 1.47221],
  ["AAPL", "USD", "USD", 1.97754],
] as const;
for (const [symbol, epsCurrency, revenueCurrency, eps] of fixtures) {
  test(`recorded ${symbol} keeps each explicit forecast unit and fiscal end through loading/cache/export`, async () => {
    let requests = 0;
    const events = await loadYahooEarningsCalendar([symbol], async <T>(url: string) => {
      requests++;
      expect(new URL(url).searchParams.get("modules")).toBe("calendarEvents,earningsTrend,quoteType");
      return { quoteSummary: { result: [recordedEarnings[symbol]] } } as T;
    });
    const event = events[0]!;
    expect(event.epsEstimate).toBe(eps);
    expect(event.estimateBasis?.epsEstimate).toMatchObject({ currency: epsCurrency, period: "0q", periodEndDate: "2026-09-30", source: "earningsTrend" });
    expect(event.estimateBasis?.revenueEstimate?.currency).toBe(revenueCurrency);
    expect(earningsForecastPeriod(event)).toEqual({ period: "0q", periodEndDate: "2026-09-30" });
    expect(event.earningsDate.toISOString().slice(0, 10)).not.toBe("2026-09-30");
    attachEarningsCalendarPersistence(new MemoryPluginPersistence());
    let providerCalls = 0;
    const provider = { getEarningsCalendar: async () => { providerCalls++; return events; } } as never;
    await loadEarningsCalendar(provider, [symbol]);
    const cached = await loadEarningsCalendar(provider, [symbol]);
    const report = projectEarningsCalendarHeadless(cached, args);
    expect(report.rows[0]).toMatchObject({ epsEstimate: eps, epsCurrency, revenueCurrency, forecastPeriod: "0q", forecastPeriodEnd: "2026-09-30", estimateBasis: event.estimateBasis });
    expect(providerCalls).toBe(1);
    expect(requests).toBe(1);
    const cell = renderEarningsCell({ kind: "event", key: symbol, eventIdx: 0, event }, buildEarningsColumns(240).find(c => c.id === "epsEstimate")!, false);
    expect(cell.text).toStartWith(epsCurrency);
  });
}

function synthetic(): YahooQuoteSummaryResult {
  return {
    price: { currency: "USD" },
    calendarEvents: { earnings: { earningsDate: [{ raw: Date.parse("2026-11-05T21:00:00Z") / 1000 }], earningsAverage: 5, earningsLow: 4, earningsHigh: 6, revenueAverage: 100 } },
    earningsTrend: { trend: [{ period: "0q", endDate: "2026-09-30",
      earningsEstimate: { avg: 150, low: 120, high: 180, yearAgoEps: 100, numberOfAnalysts: 4, growth: 0.5, earningsCurrency: "GBp" },
      revenueEstimate: { avg: 100, revenueCurrency: "GBP" },
      epsTrend: { "7daysAgo": 0.2, "30daysAgo": 0.5, epsTrendCurrency: "GBP" },
      epsRevisions: { upLast30days: 2, downLast30days: 0 },
    }] },
  };
}

test("explicit minor-unit amounts normalize once, including zero, without changing counts or growth", () => {
  const source = synthetic();
  const event = mapYahooEarningsCalendarEvent(source, "SYN")!;
  expect(event).toMatchObject({ epsEstimate: 1.5, epsLow: 1.2, epsHigh: 1.8, epsYearAgo: 1, epsAnalysts: 4, epsGrowth: 0.5, epsTrend30dAgo: 0.5 });
  expect(event.estimateBasis?.epsEstimate).toMatchObject({ currency: "GBP", sourceCurrency: "GBp", sourceValue: 150 });
  expect(earningsEpsChange30d(event)).toBe(1);
  expect(event.estimateBasis?.epsAnalysts?.currency).toBeUndefined();
  source.earningsTrend!.trend![0]!.earningsEstimate!.avg = 0;
  const zero = mapYahooEarningsCalendarEvent(source, "SYN")!;
  expect(zero.epsEstimate).toBe(0);
  expect(earningsEpsChange30d(zero)).toBe(-0.5);
});

test("missing or incompatible EPS trend currency/period cannot create a 30-day change", () => {
  for (const currency of [undefined, "", "XXX", "unknown", "JPY"]) {
    const source = synthetic();
    source.earningsTrend!.trend![0]!.epsTrend!.epsTrendCurrency = currency;
    const event = mapYahooEarningsCalendarEvent(source, "SYN")!;
    expect(earningsEpsChange30d(event)).toBeNull();
  }
  for (const endDate of [undefined, "", "2026-02-30"]) {
    const source = synthetic();
    source.earningsTrend!.trend![0]!.endDate = endDate;
    expect(earningsEpsChange30d(mapYahooEarningsCalendarEvent(source, "SYN")!)).toBeNull();
  }
  const source = synthetic();
  source.earningsTrend!.trend![0]!.earningsEstimate!.earningsCurrency = undefined;
  const unknown = mapYahooEarningsCalendarEvent(source, "SYN")!;
  expect(unknown.estimateBasis?.epsEstimate?.currency).toBeNull();
  expect(unknown.epsEstimate).toBe(150);
  expect(earningsEpsChange30d(unknown)).toBeNull();
  const no30d = synthetic();
  delete no30d.earningsTrend!.trend![0]!.epsTrend!["30daysAgo"];
  expect(earningsEpsChange30d(mapYahooEarningsCalendarEvent(no30d, "SYN")!)).toBeNull();
});

test("calendar fallback values retain unknown basis while unrelated trend ranges/counts stay separate", () => {
  const source = synthetic();
  source.earningsTrend!.trend![0]!.earningsEstimate!.avg = null;
  source.earningsTrend!.trend![0]!.earningsEstimate!.high = null;
  const event = mapYahooEarningsCalendarEvent(source, "SYN")!;
  expect(event.epsEstimate).toBe(5);
  expect(event.estimateBasis?.epsEstimate).toEqual({ source: "calendarEvents", sourceValue: 5, period: null, periodEndDate: null, currency: null, sourceCurrency: null });
  expect(event.epsLow).toBe(1.2);
  expect(event.epsHigh).toBe(6);
  expect(coherentEarningsValue(event, "epsLow")).toBeNull();
  expect(coherentEarningsValue(event, "epsHigh")).toBe(6);
  for (const field of ["epsGrowth", "epsAnalysts", "epsRevisionUp30d", "epsRevisionDown30d"] as const) expect(coherentEarningsValue(event, field)).toBeNull();
  expect(earningsEpsChange30d(event)).toBeNull();
  expect(earningsForecastPeriod(event)).toBeNull();
  const report = projectEarningsCalendarHeadless({ events: [event], fetchedAt: 123, stale: false }, args);
  expect(report.rows[0]).toMatchObject({ epsEstimate: 5, epsCurrency: null, epsLow: null, epsHigh: 6, epsGrowth: null, epsAnalysts: null, epsChange30d: null, forecastPeriodEnd: null,
    sourceEstimates: { epsEstimate: 5, epsLow: 1.2, epsGrowth: 0.5, epsAnalysts: 4, epsRevisionUp30d: 2 } });
});

test("missing averages cannot combine independently sourced range endpoints", () => {
  const source = synthetic();
  const trend = source.earningsTrend!.trend![0]!;
  const calendar = source.calendarEvents!.earnings!;
  trend.earningsEstimate!.avg = null;
  trend.earningsEstimate!.high = null;
  trend.revenueEstimate!.avg = null;
  trend.revenueEstimate!.low = 80;
  calendar.earningsAverage = undefined;
  calendar.revenueAverage = undefined;
  calendar.revenueHigh = 120;
  const event = mapYahooEarningsCalendarEvent(source, "SYN")!;
  const report = projectEarningsCalendarHeadless({ events: [event], fetchedAt: 123, stale: false }, args);
  expect(report.rows[0]).toMatchObject({ epsEstimate: null, epsLow: null, epsHigh: null,
    revenueEstimate: null, revenueLow: null, revenueHigh: null,
    sourceEstimates: { epsLow: 1.2, epsHigh: 6, revenueLow: 80, revenueHigh: 120 },
    estimateBasis: { epsLow: { sourceValue: 120, sourceCurrency: "GBp" }, epsHigh: { sourceValue: 6, currency: null } } });
  for (const id of ["epsRange", "revenueRange"]) {
    expect(renderEarningsCell({ kind: "event", key: "SYN", eventIdx: 0, event }, buildEarningsColumns(240).find(c => c.id === id)!, false).text).toBe("—");
  }
  trend.earningsEstimate!.high = 180;
  const samePeriod = mapYahooEarningsCalendarEvent(source, "SYN")!;
  expect(coherentEarningsValue(samePeriod, "epsLow")).toBe(1.2);
  expect(coherentEarningsValue(samePeriod, "epsHigh")).toBe(1.8);
});

test("a common fiscal end cannot assign the revenue period to an independently sourced EPS range", () => {
  const source = synthetic();
  source.earningsTrend!.trend![0]!.earningsEstimate = {};
  source.earningsTrend!.trend![0]!.epsTrend = {};
  source.earningsTrend!.trend![0]!.epsRevisions = {};
  source.calendarEvents!.earnings!.earningsAverage = undefined;
  const mixed = mapYahooEarningsCalendarEvent(source, "SYN")!;
  expect(coherentEarningsValue(mixed, "epsLow")).toBe(4);
  expect(coherentEarningsValue(mixed, "epsHigh")).toBe(6);
  expect(earningsForecastPeriod(mixed)).toBeNull();
  expect(mixed.estimateBasis?.revenueEstimate?.periodEndDate).toBe("2026-09-30");
  source.calendarEvents!.earnings!.earningsLow = undefined;
  source.calendarEvents!.earnings!.earningsHigh = undefined;
  expect(earningsForecastPeriod(mapYahooEarningsCalendarEvent(source, "SYN")!))
    .toEqual({ period: "0q", periodEndDate: "2026-09-30" });
});
