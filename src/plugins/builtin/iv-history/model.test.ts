import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import type { IvHistoryPayload, IvPoint, IvScreenRow } from "./client";
import { statSource } from "./format";
import { midrankPercentile, projectIvHistory, projectRichCheap, richCheapDates, verdictFor } from "./model";

const DAY = 86_400_000;
const sessions = (count: number, end = "2026-09-22") => {
  const dates: string[] = [];
  for (let time = Date.parse(`${end}T00:00:00Z`); dates.length < count; time -= DAY) {
    const weekday = new Date(time).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.unshift(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
};
const point = (sessionDate: string, iv30: number | null, method: IvPoint["method"] = "trade-close"): IvPoint => ({
  sessionDate, method, capturedAt: `${sessionDate}T20:00:00Z`, spot: 100, iv7: null, iv30, iv60: null, iv90: iv30 == null ? null : iv30 + 0.01,
  iv180: null, iv365: null, put25_30: null, call25_30: null,
});
/** Alternating +/-1% closes: close-to-close HV is about 15.9% annualized. */
const prices = (dates: readonly string[]): PricePoint[] => dates.map((date, index) => ({ date: new Date(`${date}T20:00:00Z`), close: index % 2 ? 101 : 100 }));
const payload = (series: IvPoint[], patch: Partial<IvHistoryPayload> = {}): IvHistoryPayload => ({
  version: 1, symbol: "SPY", asOf: "2026-09-23", status: "ready",
  coverage: { source: "seed", addedAt: "2026-09-23T00:00:00Z", backfilledThrough: "2026-09-22", since: series[0]?.sessionDate ?? null },
  stats: { iv30: null, iv90: null }, latest: null, series, warnings: [], ...patch,
});

describe("IV history against realized", () => {
  const dates = sessions(400);
  const series = dates.map((date, index) => point(date, index === 200 ? null : 0.2));
  const model = projectIvHistory(payload(series, {
    latest: { date: "2026-09-23", method: "quote-mid", capturedAt: "2026-09-23T19:50:00Z", spot: 100, iv7: null, iv30: 0.22,
      iv60: null, iv90: 0.24, iv180: null, iv365: null },
  }), prices(dates), { lookback: "1Y", hvWindow: 20 });

  test("clips to the lookback and keeps gaps", () => {
    expect(model.asOf).toBe("2026-09-23");
    expect(model.iv30[0]!.date.toISOString().slice(0, 10) >= "2025-09-23").toBe(true);
    expect(model.iv30.length).toBeLessThan(262);
    expect(model.iv90.every((entry) => Math.abs(entry.value! - 0.21) < 1e-9)).toBe(true);
  });
  const stat = (id: string) => model.stats.find((row) => row.id === id)!;
  test("pairs IV with same-session HV", () => {
    const hv = stat("hv");
    expect(hv.label).toBe("HV 20");
    expect(hv.value!).toBeCloseTo(0.158, 2);
    expect(hv.percentile).not.toBeNull();
    expect(stat("spread").value!).toBeCloseTo(0.2 - hv.value!, 6);
    expect(model.spread.every((entry) => entry.value == null || Math.abs(entry.value - (0.2 - hv.value!)) < 1e-6)).toBe(true);
    expect(model.hv[0]!.date.getTime()).toBeGreaterThanOrEqual(model.iv30[0]!.date.getTime());
    expect(stat("term").value!).toBeCloseTo(0.2 / 0.21);
  });
  test("a newer quote reading gets its own unranked row, never called live", () => {
    expect(stat("iv30-quote")).toMatchObject({ label: "IV 30d quote", value: 0.22, date: "2026-09-23", method: "quote-mid", rank: null, percentile: null });
    expect(model.stats.map((row) => row.id)).toEqual(["iv30", "iv30-quote", "iv90", "iv365", "hv", "spread", "term"]);
    expect([stat("iv30-quote"), stat("hv"), stat("spread")].map((row) => statSource(row))).toEqual(["quote", "closes", "close"]);
  });
  test("a constant series ranks mid without a range", () => {
    expect(stat("spread").rank).toBeNull();
    expect(stat("spread").percentile).toBe(50);
  });
  test("coverage states become warnings", () => {
    expect(projectIvHistory(payload([], { status: "queued" }), []).warnings.join(" ")).toContain("queued");
    expect(projectIvHistory(payload([], { status: "backfilling" }), prices(dates)).warnings[0]).toContain("backfilling");
  });
});

describe("the one-year tenor", () => {
  const dates = sessions(300);
  const stats = (percentile: number | null, samples: number, date = dates.at(-1)!) => ({ value: 0.27, date, method: "trade-close" as const,
    rank: percentile, percentile, low: 0.2, high: 0.3, samples, windowStart: dates[0]!, minSamples: 60, rankNote: null });
  /** IV30 every session; IV1Y from session `from` on, every other session. */
  const series = (from: number) => dates.map((date, index) => ({ ...point(date, 0.2), iv365: index >= from && index % 2 === 0 ? 0.27 : null }));
  const project = (from: number, iv365: ReturnType<typeof stats> | null, coverage: Partial<NonNullable<IvHistoryPayload["coverage"]>> = {}) =>
    projectIvHistory(payload(series(from), {
      stats: { iv30: null, iv90: null, iv365 },
      coverage: { source: "seed", addedAt: "", backfilledThrough: dates.at(-1)!, since: dates[0]!, ...coverage },
    }), prices(dates), { lookback: "ALL" });

  test("a short 1Y history says where it starts and how deep it is, without a rank", () => {
    const model = project(250, stats(null, 24), { iv365Since: dates[250] });
    expect(model.oneYearNote).toBe(`IV1Y from ${dates[250]}, 25 sessions`);
    expect(model.iv365).toHaveLength(25);
    expect(model.stats.find((row) => row.id === "iv365")).toMatchObject({ label: "IV 1Y ATM", value: 0.27, rank: null, samples: 24 });
  });
  test("a ranked 1Y history is noted only when it starts later than the rest", () => {
    expect(project(0, stats(55, 140)).oneYearNote).toBeNull();
    expect(project(40, stats(55, 120), { iv365Since: dates[40] }).oneYearNote).toBe(`IV1Y from ${dates[40]}`);
  });
  test("with no 1Y close, a stored quote gives the level unranked and the footer says so", () => {
    const model = projectIvHistory(payload(series(Number.POSITIVE_INFINITY), {
      stats: { iv30: null, iv90: null, iv365: null },
      latest: { date: "2026-09-23", method: "quote-mid", capturedAt: "", spot: 100, iv7: null, iv30: 0.2, iv60: null, iv90: 0.21, iv180: null, iv365: 0.26 },
    }), prices(dates));
    expect(model.oneYearNote).toBe("no IV1Y history yet");
    expect(model.iv365).toEqual([]);
    expect(model.stats.find((row) => row.id === "iv365")).toMatchObject({ value: 0.26, date: "2026-09-23", method: "quote-mid", rank: null, percentile: null });
  });
});

test("midrank percentile needs enough samples", () => {
  expect(midrankPercentile([1, 2, 3], 2)).toBeNull();
  const samples = Array.from({ length: 20 }, (_, index) => index);
  expect(midrankPercentile(samples, 100, 20)).toBe(100);
  expect(midrankPercentile(samples, 10, 20)).toBeCloseTo(52.5);
  expect(midrankPercentile(samples, 10)).toBeNull();
});

test("rich and cheap follow the IV percentile", () => {
  expect([verdictFor(85), verdictFor(80), verdictFor(50), verdictFor(20), verdictFor(null)]).toEqual(["rich", "rich", "fair", "cheap", null]);
  const row: IvScreenRow = {
    symbol: "AAPL", status: "ready",
    iv30: { value: 0.3, date: "2026-09-22", method: "trade-close", rank: 70, percentile: 88, low: 0.2, high: 0.4, samples: 250, windowStart: "2025-09-22" },
    iv90: null,
    latest: { date: "2026-09-23", method: "quote-mid", capturedAt: "", spot: 200, iv7: null, iv30: 0.32, iv60: null, iv90: 0.3, iv180: null, iv365: null },
    skew: { date: "2026-09-23", put25: 0.36, call25: 0.29, skew: 0.07 },
  };
  const [projected] = projectRichCheap([row, { symbol: "ZZZZ", status: "queued", iv30: null, iv90: null, latest: null, skew: null }], new Map([["AAPL", 0.25]]));
  expect(projected).toMatchObject({ iv30: 0.32, rankDate: "2026-09-22", verdict: "rich", skew: 0.07, iv1y: null, iv1yPercentile: null });
  // IVP1Y shows only when the 1Y series was ranked on the close IVR and IVP are.
  const oneYear = (date: string) => ({ ...row, latest: { ...row.latest!, iv365: 0.28 },
    iv365: { ...row.iv30!, value: 0.27, percentile: 35, date } });
  expect(projectRichCheap([oneYear("2026-09-22")])[0]).toMatchObject({ iv1y: 0.28, iv1yPercentile: 35 });
  expect(projectRichCheap([oneYear("2026-09-19")])[0]).toMatchObject({ iv1y: 0.28, iv1yPercentile: null });
  // A percentile never stands without the IV1Y it describes.
  expect(projectRichCheap([{ ...oneYear("2026-09-22"), latest: row.latest }])[0]).toMatchObject({ iv1y: null, iv1yPercentile: null });
  expect(projected!.termSlope).toBeCloseTo(0.02);
  expect(projected!.ivHv).toBeCloseTo(1.28);
});

test("a queued symbol does not break a date every other row shares", () => {
  const ready = (symbol: string, rankDate: string): IvScreenRow => ({
    symbol, status: "ready", iv90: null, skew: null,
    iv30: { value: 0.3, date: rankDate, method: "trade-close", rank: 70, percentile: 88, low: 0.2, high: 0.4, samples: 250, windowStart: "2025-09-22" },
    latest: { date: "2026-09-23", method: "quote-mid", capturedAt: "", spot: 200, iv7: null, iv30: 0.32, iv60: null, iv90: 0.3, iv180: null, iv365: null },
  });
  const queued: IvScreenRow = { symbol: "ZZZZ", status: "queued", iv30: null, iv90: null, latest: null, skew: null };
  expect(richCheapDates(projectRichCheap([ready("A", "2026-09-22"), queued, ready("B", "2026-09-22")])))
    .toEqual({ reading: { date: "2026-09-23", method: "quote-mid" }, rank: "2026-09-22", rankApart: false, skewApart: false });
  expect(richCheapDates(projectRichCheap([ready("A", "2026-09-22"), ready("B", "2026-09-21")])))
    .toMatchObject({ rank: null, rankApart: true });
});
