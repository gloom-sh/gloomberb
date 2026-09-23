import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import type { IvHistoryPayload, IvPoint, IvScreenRow } from "./client";
import { midrankPercentile, projectIvHistory, projectRichCheap, verdictFor } from "./model";

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
  test("a newer live reading gets its own unranked row", () => {
    expect(stat("iv30-live")).toMatchObject({ value: 0.22, date: "2026-09-23", method: "quote-mid", rank: null, percentile: null });
    expect(model.stats.map((row) => row.id)).toEqual(["iv30", "iv30-live", "iv90", "hv", "spread", "term"]);
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
  expect(projected).toMatchObject({ iv30: 0.32, rankDate: "2026-09-22", verdict: "rich", skew: 0.07 });
  expect(projected!.termSlope).toBeCloseTo(0.02);
  expect(projected!.ivHv).toBeCloseTo(1.28);
});
