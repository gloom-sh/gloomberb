import { afterEach, expect, test } from "bun:test";
import type { EarningsEvent, EarningsEstimateBasis } from "../../../types/data-provider";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachEarningsCalendarPersistence, loadEarningsCalendar, resetEarningsCalendarPersistence } from "./data/cache";
import { coherentEarningsValue, earningsEpsChange30d, earningsForecastPeriod } from "./estimate-basis";
import { recordedEarnings } from "./estimate-fixtures.test-data";

afterEach(resetEarningsCalendarPersistence);
const fixtures = [
  ["SONY", "USD", "JPY", 0.33459],
  ["6758.T", "JPY", "JPY", 63.08788],
  ["BABA", "CNY", "CNY", 10.97892],
  ["9988.HK", "CNY", "CNY", 1.47221],
  ["AAPL", "USD", "USD", 1.97754],
] as const;
for (const [symbol, epsCurrency, revenueCurrency, eps] of fixtures) {
  test(`recorded ${symbol} keeps each explicit forecast unit and fiscal end through loading and the cache`, async () => {
    const captured = recordedEarnings[symbol];
    const events = [{ ...captured, earningsDate: new Date(captured.earningsDate), earningsCallDate: captured.earningsCallDate ? new Date(captured.earningsCallDate) : null }] as unknown as EarningsEvent[];
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
    expect(cached.events[0]?.estimateBasis).toEqual(event.estimateBasis);
    expect(providerCalls).toBe(1);
  });
}

function synthetic(): EarningsEvent {
  const basis = (currency: string | null = "GBP"): EarningsEstimateBasis => ({ source: "earningsTrend", sourceValue: 1.5, sourceCurrency: currency, currency, period: "0q", periodEndDate: "2026-09-30" });
  return { symbol: "SYN", earningsDate: new Date("2026-11-05"), epsEstimate: 1.5, epsLow: 1.2, epsHigh: 1.8, epsTrend30dAgo: 0.5,
    estimateBasis: { epsEstimate: basis(), epsLow: basis(), epsHigh: basis(), epsTrend30dAgo: basis() } } as EarningsEvent;
}

test("EPS comparisons require matching units and fiscal periods even when values are available", () => {
  const event = synthetic();
  expect(earningsEpsChange30d(event)).toBe(1);
  event.epsEstimate = 0;
  expect(earningsEpsChange30d(event)).toBe(-0.5);
  for (const currency of [null, "", "XXX", "JPY"]) {
    event.estimateBasis!.epsTrend30dAgo!.currency = currency;
    expect(earningsEpsChange30d(event)).toBeNull();
  }
  event.estimateBasis!.epsTrend30dAgo!.currency = "GBP";
  event.estimateBasis!.epsTrend30dAgo!.periodEndDate = "2026-06-30";
  expect(earningsEpsChange30d(event)).toBeNull();
  expect(earningsForecastPeriod(event)).toEqual({ period: "0q", periodEndDate: "2026-09-30" });
});

test("independently sourced ranges cannot inherit an average's basis or a shared fiscal date", () => {
  const event = synthetic();
  event.estimateBasis!.epsEstimate = { source: "calendarEvents", sourceValue: 5, currency: null, sourceCurrency: null, period: null, periodEndDate: null };
  expect(coherentEarningsValue(event, "epsEstimate")).toBe(1.5);
  expect(coherentEarningsValue(event, "epsLow")).toBeNull();
  expect(earningsForecastPeriod(event)).toBeNull();
  event.epsEstimate = null;
  expect(coherentEarningsValue(event, "epsLow")).toBe(1.2);
  event.estimateBasis!.epsHigh!.currency = "USD";
  expect(coherentEarningsValue(event, "epsLow")).toBeNull();
  expect(coherentEarningsValue(event, "epsHigh")).toBeNull();
});
