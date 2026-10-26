import { expect, test } from "bun:test";
import { dailyMetricReading, metricTrigger, type AlertMetric, type MetricRule } from "./metric-model";
import { getPublishedUsEquitySession } from "../../../market-data/published-us-sessions";
import { valuationAlertValue } from "./metric-data";
import { parseAlertAddArgs } from "./cli";
import { parseAlertCommandValues, parseAlertShortcutValues } from "./command";
import { rearmAlert, evaluateAlert } from "./alert-engine";
import { readLevelAlertStores, writeLevelAlertStores } from "./storage";
import type { AlertRule } from "./types";
import type { TickerFinancials } from "../../../types/financials";

const calendar = (day: string) => getPublishedUsEquitySession("NASDAQ", day);
const sessionDays = (n: number) => {
  const days: string[] = [];
  for (let time = Date.parse("2026-01-02"); days.length < n; time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (calendar(day)?.kind === "session") days.push(day);
  }
  return days;
};
const bars = (closes: number[]) => sessionDays(closes.length).map((date, i) => ({ date, close: closes[i]! }));
const after = (day: string) => Date.parse(`${day}T22:00:00Z`);
const rule = (metric: AlertMetric, targetPrice = 30): AlertRule => ({ id: "fixture", symbol: "NVDA", exchange: "NASDAQ", condition: metric.kind === "ma_cross" ? "crosses" : "below", metric, targetPrice, status: "active", createdAt: Date.parse("2026-01-01") });
const reading = (r: MetricRule, closes: number[]) => {
  const rows = bars(closes);
  return dailyMetricReading(r, rows, after(rows.at(-1)!.date), calendar);
};

test("Wilder RSI uses the initial 14 changes and smooths later changes, with defined flat and one-sided series", () => {
  const r = rule({ kind: "rsi", period: 14 });
  const closes = [44.34,44.09,44.15,43.61,44.33,44.83,45.1,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46,46.03,46.41,46.22,45.64,46.21];
  expect(reading(r, closes.slice(0, 15)).value).toBeCloseTo(70.4641, 4);
  expect(reading(r, closes).value).toBeCloseTo(62.8807, 4);
  expect(reading(r, Array(16).fill(10)).value).toBe(50);
  expect(reading(r, Array.from({ length: 16 }, (_, i) => i + 1)).value).toBe(100);
  expect(reading(r, Array.from({ length: 16 }, (_, i) => 20 - i)).value).toBe(0);
});

test("50/200 MA crosses compare consecutive windows, fire once, and re-arming starts at a future close", () => {
  const r = rule({ kind: "ma_cross", period: 50, slowPeriod: 200, direction: "above" }, 0);
  const closes = [...Array(200).fill(100), 110];
  const cross = reading(r, closes);
  expect(cross.value).toBeCloseTo(100.2, 8);
  expect(cross.target).toBeCloseTo(100.05, 8);
  expect(metricTrigger(r, cross)).toBe("up");
  expect(metricTrigger({ ...r, lastDailyClose: cross.day }, cross)).toBeNull();
  expect(metricTrigger({ ...r, status: "triggered" }, cross)).toBeNull();
  expect(metricTrigger(r, reading(r, [...closes, 112]))).toBeNull();
  expect(metricTrigger({ ...r, armedAt: cross.at }, cross)).toBeNull();
  const down = rule({ ...r.metric as Extract<AlertMetric, { kind: "ma_cross" }>, direction: "below" }, 0);
  expect(metricTrigger(down, reading(down, [...Array(200).fill(100), 90]))).toBe("down");
  expect(rearmAlert({ ...r, lastDailyClose: cross.day, lastCheckedTarget: 100 }).metric).toEqual(r.metric);
  expect(rearmAlert(r).lastDailyClose).toBeUndefined();
  expect(evaluateAlert(r, 200)).toBe(false);
});

test("intraday bars cannot trigger; the next completed close can, including early closes", () => {
  const r = rule({ kind: "close_ma", period: 200 }, 0);
  const rows = bars([...Array(201).fill(100), 90]);
  const day = rows.at(-1)!.date;
  const session = calendar(day)!;
  if (session.kind !== "session") throw new Error("fixture needs a session");
  const armed = { ...r, armedAt: session.close - 3_600_000 };
  const before = dailyMetricReading(armed, rows, session.close - 1, calendar);
  expect(metricTrigger(armed, before)).toBeNull();
  for (const minutes of [15, 29.999]) expect(metricTrigger(armed, dailyMetricReading(armed, rows, session.close + minutes * 60_000, calendar))).toBeNull();
  const completed = dailyMetricReading(armed, rows, session.close + 30 * 60_000, calendar);
  expect(metricTrigger(armed, completed)).toBe("below");
  const short = rule({ kind: "close_ma", period: 2 }, 0);
  expect(reading(short, [100, 90])).toMatchObject({ value: 90, target: 95 });
  const early = [{ date: "2026-11-24", close: 100 }, { date: "2026-11-25", close: 100 }, { date: "2026-11-27", close: 80 }];
  expect(dailyMetricReading(short, early, Date.parse("2026-11-27T18:30:00Z"), calendar).day).toBe("2026-11-27");
});

test("missing, invalid, duplicate and short histories never bridge a session or fabricate a technical value", () => {
  const r = rule({ kind: "rsi", period: 14 });
  const rows = bars(Array.from({ length: 20 }, (_, i) => 20 - i));
  const now = after(rows.at(-1)!.date);
  expect(() => dailyMetricReading(r, rows.filter((_, i) => i !== 10), now, calendar)).toThrow("missing");
  expect(() => dailyMetricReading(r, rows.slice(0, -1), now, calendar)).toThrow("Waiting");
  expect(() => dailyMetricReading(r, rows.slice(-10), now, calendar)).toThrow("Need 15");
  expect(() => dailyMetricReading(r, [...rows, rows[10]!], now, calendar)).toThrow("duplicate");
  expect(() => dailyMetricReading(r, rows.map((b, i) => i === 10 ? { ...b, close: NaN } : b), now, calendar)).toThrow("invalid");
});

test("trailing valuation rejects losses, missing figures and currency mismatches, and reads regular-session multiples", () => {
  const data = { quote: { symbol: "AAPL", price: 240, previousClose: 240, currency: "USD", marketCap: 2400, marketState: "REGULAR", lastUpdated: Date.parse("2026-10-23T19:00Z") }, fundamentals: { trailingPE: 24, eps: 10, sharesOutstanding: 10, revenue: 300, financialCurrency: "USD", marketCapCurrency: "USD" } } as TickerFinancials;
  expect(valuationAlertValue("pe", data)).toBe(24);
  expect(valuationAlertValue("ps", data)).toBe(8);
  expect(valuationAlertValue("pe", { ...data, fundamentals: { ...data.fundamentals, eps: -1 } })).toBeNull();
  expect(valuationAlertValue("pe", { ...data, fundamentals: { ...data.fundamentals, eps: 0 } })).toBeNull();
  expect(valuationAlertValue("pe", { ...data, fundamentals: { eps: undefined } })).toBeNull();
  // The panes retain a served, meaningful P/E even when EPS is not independently supplied.
  expect(valuationAlertValue("pe", { ...data, fundamentals: { ...data.fundamentals, eps: undefined } })).toBe(24);
  expect(valuationAlertValue("ps", { ...data, fundamentals: { ...data.fundamentals, financialCurrency: "EUR" } })).toBeNull();
  expect(valuationAlertValue("pe", { ...data, quote: { ...data.quote!, stale: true } })).toBeNull();
  expect(valuationAlertValue("pe", { ...data, quote: { ...data.quote!, price: 0 } })).toBeNull();
});

test("CLI and form parse the trader examples identically and isolate their storage from old price evaluators", () => {
  for (const [text, kind] of [
    ["AAPL P/E below 25", "pe"], ["AAPL P/S above 8", "ps"], ["NVDA RSI(14) under 30", "rsi"],
    ["SPY 50-day MA crosses above the 200-day", "ma_cross"], ["TSLA closes below its 200-day", "close_ma"],
  ] as const) {
    const parsed = parseAlertAddArgs(text!.split(" "), undefined);
    expect(parsed.kind).toBe("metric");
    if (parsed.kind !== "metric") throw new Error("fixture");
    expect(parsed.metric.kind).toBe(kind);
    expect(parseAlertCommandValues(parseAlertShortcutValues(text!))).toEqual({ symbol: parsed.symbol, condition: parsed.condition, price: parsed.price, metric: parsed.metric });
    const alert = { ...rule(parsed.metric, parsed.price), condition: parsed.condition };
    const saved = writeLevelAlertStores([alert]);
    expect(saved.alerts).toBe("[]");
    expect(readLevelAlertStores(key => saved[key]).alerts[0]?.metric).toEqual(parsed.metric);
  }
  for (const text of ["AAPL pe below -25", "NVDA rsi(1) below 30", "NVDA rsi(14) below 101", "SPY ma(200) crosses above ma(50)", "SPY ma(50) above ma(200)", "TSLA closes below ma(201)"]) {
    expect(() => parseAlertAddArgs(text.split(" "), undefined)).toThrow();
  }
});


test("valuation alerts keep the regular close and converted EPS basis outside regular trading", () => {
  for (const marketState of ["PRE", "POST", "CLOSED"] as const) {
    const financials = {
      quote: { symbol: "AAPL", exchangeName: "NASDAQ", price: 260, regularClose: 240,
        regularCloseSessionDate: "2026-10-23", changeSessionDate: marketState === "PRE" ? "2026-10-26" : "2026-10-23",
        regularChange: 10, marketState, currency: "USD", marketCap: 2600, previousClose: 230,
        lastUpdated: Date.parse("2026-10-23T20:30Z") },
      fundamentals: { trailingPE: 26, eps: 5, trailingPEConversion: { rate: 2 }, sharesOutstanding: 10,
        revenue: 300, financialCurrency: "USD", marketCapCurrency: "USD" },
    } as TickerFinancials;
    expect(valuationAlertValue("pe", financials)).toBe(24);
    expect(valuationAlertValue("ps", financials)).toBe(8);
    // A cap already measured at the close must not move down a second time.
    expect(valuationAlertValue("ps", { ...financials, quote: { ...financials.quote!, marketCap: 2400 } })).toBe(8);
  }
});

// These same fixtures run against delivery's valuation and bar-day adapters.
import parity from "./metric-parity-fixture.json";
import { barSessionDay } from "../../../market-data/market/period-return";
test("metric model and valuation fixtures preserve delivery parity", async () => {
  expect(new Bun.CryptoHasher("sha256").update(await Bun.file(new URL("./metric-model.ts", import.meta.url)).text()).digest("hex")).toBe(parity.modelSha256);
  for (const fixture of parity.valuations) for (const kind of ["pe", "ps"] as const) {
    expect(valuationAlertValue(kind, fixture.data as unknown as TickerFinancials), `${fixture.name} ${kind}`).toBe(fixture[kind]);
  }
  for (const fixture of parity.barDays) expect(barSessionDay(Date.parse(fixture.stamp), fixture.exchange)).toBe(fixture.day);
});
