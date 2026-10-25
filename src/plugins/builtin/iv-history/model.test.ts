import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import type { IvHistoryPayload, IvPoint, IvScreenRow, ScreenHv } from "./client";
import { statSource } from "./format";
import { hvOn, midrankPercentile, projectIvHistory, projectRichCheap, richCheapDates, screenCoverage, screenPaneNotices, screenStaleNote, sessionsBehind, verdictFor } from "./model";

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
/** HV after each given session's close; the newest is the symbol's current. */
const hvSeries = (points: ReadonlyArray<readonly [string, number]>): ScreenHv => ({ value: points.at(-1)?.[1] ?? null, date: points.at(-1)?.[0] ?? null, series: points });
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
  test("coverage states become warnings, a queued one with when to look again", () => {
    const queuedAt = Date.parse("2026-09-23T06:25:59Z");
    const queued = (now: number) => projectIvHistory(payload([], { status: "queued",
      coverage: { source: "demand", addedAt: "2026-09-23T06:25:59Z", backfilledThrough: null, since: null } }), [], { now }).warnings[0];
    expect(queued(queuedAt + 60_000)).toBe("SPY queued for backfill since 06:25 UTC; "
      + "a first backfill usually takes under 10 minutes, try again after 06:35 UTC.");
    // Past the usual wait there is no estimate left to give.
    expect(queued(queuedAt + 30 * 60_000)).toBe("SPY queued for backfill since 06:25 UTC; longer than the usual 10 minutes, try again shortly.");
    expect(projectIvHistory(payload([], { status: "backfilling",
      coverage: { source: "demand", addedAt: "", backfilledThrough: "2025-03-14", since: null } }), prices(dates)).warnings[0])
      .toBe("SPY backfilling through 2025-03-14.");
    expect(projectIvHistory(payload([], { status: "unavailable" }), prices(dates)).warnings[0]).toBe("No options history for SPY.");
    // Demand coverage full: the server's queue wording gives way to a plain line, and a finished backfill with no options is not the same thing.
    expect(projectIvHistory(payload([], { status: "unavailable", warnings: ["Coverage for new underlyings is full; try again later."] }), prices(dates)).warnings[0])
      .toBe("No IV history for SPY yet.");
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
  const [projected] = projectRichCheap([row, { symbol: "ZZZZ", status: "queued", iv30: null, iv90: null, latest: null, skew: null }],
    new Map([["AAPL", hvSeries([["2026-09-23", 0.25]])]]));
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
    .toEqual({ reading: { date: "2026-09-23", method: "quote-mid", basis: null }, rank: "2026-09-22", rankApart: false, skewApart: false });
  expect(richCheapDates(projectRichCheap([ready("A", "2026-09-22"), ready("B", "2026-09-21")])))
    .toMatchObject({ rank: null, rankApart: true });
});

describe("VCA backfill states", () => {
  const NOW = Date.parse("2026-10-11T08:04:00Z");
  const reading = { date: "2026-10-09", method: "trade-close" as const, capturedAt: "", spot: 100, iv7: null, iv30: 0.3, iv60: null, iv90: 0.31,
    iv180: null, iv365: null };
  const ready: IvScreenRow = { symbol: "AAPL", status: "ready", coverageStatus: "ready", latest: reading, iv90: null, skew: null,
    coverage: { source: "seed", addedAt: "2026-01-01T00:00:00Z", backfilledThrough: "2026-10-09" }, warnings: [],
    iv30: { value: 0.3, date: "2026-10-09", method: "trade-close", rank: 70, percentile: 88, low: 0.2, high: 0.4, samples: 250, windowStart: "2025-10-09" } };
  const pending = (symbol: string, coverageStatus: IvScreenRow["coverageStatus"], addedAt: string, backfilledThrough: string | null,
    warnings: string[] = []): IvScreenRow => ({ symbol, status: coverageStatus === "unavailable" && !warnings.length ? "ready" : "queued",
    coverageStatus, coverage: warnings.length ? null : { source: "demand", addedAt, backfilledThrough }, warnings,
    iv30: null, iv90: null, latest: null, skew: null });
  const rows = projectRichCheap([
    ready,
    pending("ZZZZ", "queued", "2026-10-11T07:58:12Z", null),
    pending("YYYY", "queued", "2026-10-10T23:40:00Z", null),
    pending("ABCD", "backfilling", "2026-10-11T07:31:00Z", "2025-03-14"),
    pending("PFAI", "unavailable", "2026-10-11T04:09:51Z", "2026-10-09"),
    pending("NEXE", "unavailable", "2026-10-11T00:45:22Z", "2026-10-09"),
    pending("FULL", "unavailable", "", null, ["Coverage for new underlyings is full; try again later."]),
  ]);

  test("each state is dated, and only history still to come leaves the screen incomplete", () => {
    expect(screenCoverage(rows, { now: NOW })).toEqual({
      notes: [
        // Ten minutes from the newest queued symbol; one queued on another day carries its date.
        "Queued for backfill: ZZZZ since 07:58 UTC, YYYY since 2026-10-10 23:40 UTC; a first backfill usually takes under 10 minutes, try again after 08:08 UTC.",
        "Backfilling: ABCD through 2025-03-14.",
        "No options history: PFAI, NEXE.",
        // The server's queue wording is not repeated, and nothing is promised for a name whose history is not being collected.
        "No IV history yet: FULL.",
      ],
      pending: ["ZZZZ", "YYYY", "ABCD", "FULL"],
      missing: ["ZZZZ", "YYYY", "ABCD", "FULL"],
    });
    // Finished without options is final: nothing left to wait for.
    expect(screenCoverage(rows.filter((row) => row.symbol === "AAPL" || row.symbol === "PFAI"), { now: NOW }))
      .toEqual({ notes: ["No options history: PFAI."], pending: [], missing: [] });
    // A backfill with readings so far is still incomplete, but not missing.
    const partial = projectRichCheap([{ ...pending("ABCD", "backfilling", "", "2025-03-14"), latest: reading }]);
    expect(screenCoverage(partial, { now: NOW })).toMatchObject({ pending: ["ABCD"], missing: [] });
    // Past the usual wait it says so instead of a time.
    expect(screenCoverage(rows.filter((row) => row.symbol === "YYYY"), { now: NOW }).notes)
      .toEqual(["Queued for backfill: YYYY since 2026-10-10 23:40 UTC; longer than the usual 10 minutes, try again shortly."]);
  });

  test("the pane says the same without a time to come back at", () => {
    expect(screenPaneNotices(rows, NOW).slice(0, 2)).toEqual([
      "Queued for backfill: ZZZZ since 07:58 UTC, YYYY since 2026-10-10 23:40 UTC; a first backfill usually takes under 10 minutes.",
      "Backfilling: ABCD through 2025-03-14.",
    ]);
    expect(screenPaneNotices(rows, NOW)).toHaveLength(4);
  });

  test("an older server's ready or queued reads as before in the pane", () => {
    const old = projectRichCheap([
      { symbol: "AAPL", status: "ready", iv30: ready.iv30, iv90: null, latest: reading, skew: null },
      { symbol: "ZZZZ", status: "queued", iv30: null, iv90: null, latest: null, skew: null },
      // Finished without options: an older server calls it ready, with nothing stored.
      { symbol: "PFAI", status: "ready", iv30: null, iv90: null, latest: null, skew: null },
    ]);
    expect(old.map((row) => [row.symbol, row.status, row.queuedAt, row.backfilledThrough])).toEqual([
      ["AAPL", "ready", null, null], ["ZZZZ", "queued", null, null], ["PFAI", "ready", null, null]]);
    expect(screenPaneNotices(old, NOW)).toEqual([
      "Queued for backfill: ZZZZ; a first backfill usually takes under 10 minutes.",
      "1 symbol has no stored implied volatility yet.",
    ]);
  });
});

describe("stale readings", () => {
  test("sessions behind count the published calendar: a holiday is no session", () => {
    expect(sessionsBehind("2026-10-23", "2026-10-23")).toBe(0);
    // Thursday 22 and Friday 23 after Wednesday 21; the weekend is none.
    expect(sessionsBehind("2026-10-21", "2026-10-25")).toBe(2);
    // Thanksgiving closes the 26th; the 27th, an early close, is a session.
    expect(sessionsBehind("2026-11-24", "2026-11-30")).toBe(3);
  });

  /** A screened symbol read through `through`, whose newest reading is `date`. */
  const screened = (symbol: string, date: string, extra: Partial<IvScreenRow> = {}, through = "2026-10-23"): IvScreenRow => ({
    symbol, status: "ready", coverage: { source: "demand", addedAt: "2026-10-25T16:38:00Z", backfilledThrough: through },
    iv30: { value: 0.085, date, method: "trade-close", rank: 100, percentile: 100, low: 0.06, high: 0.085, samples: 200, windowStart: "2025-10-23" },
    iv90: null, skew: null,
    latest: { date, method: "trade-close", capturedAt: "", spot: 129.1, iv7: null, iv30: 0.085, iv60: null, iv90: 0.08, iv180: null, iv365: null },
    ...extra,
  });
  const hv = new Map([["FXB", hvSeries([["2026-05-18", 0.05], ["2026-10-22", 0.053], ["2026-10-23", 0.054]])]]);

  test("a reading more than five sessions behind is shown, marked stale, and left out of IV/HV, rank and Rich/Cheap", () => {
    const [fresh, edge, stale] = projectRichCheap([screened("FXB", "2026-10-22"), screened("FXB", "2026-10-16"), screened("FXB", "2026-10-15")], hv);
    expect([fresh!.stale, edge!.stale, stale!.stale]).toEqual([false, false, true]);
    expect(stale).toMatchObject({ iv30: 0.085, date: "2026-10-15", sessionsBehind: 6, rank: null, percentile: null, rankDate: null, verdict: null, ivHv: null });
    expect(edge).toMatchObject({ verdict: "rich", rank: 100 });
    // Today's HV stays beside a stale IV30 as today's, but never divides it.
    expect(stale!.hv).toBe(0.054);
    expect(screenStaleNote([fresh!, stale!])).toBe("Stale, left out of IV/HV, rank and Rich/Cheap: FXB 2026-10-15.");
    expect(screenStaleNote([fresh!])).toBeNull();
  });

  test("IV/HV divides by the HV of the reading's own date", () => {
    const [row] = projectRichCheap([screened("FXB", "2026-10-22")], hv);
    expect(row).toMatchObject({ hv: 0.053, hvDate: "2026-10-22" });
    expect(row!.ivHv).toBeCloseTo(0.085 / 0.053);
    // A reading dated before the HV series starts has nothing to divide by.
    expect(projectRichCheap([screened("FXB", "2026-05-01")], hv)[0]).toMatchObject({ ivHv: null, stale: true });
    expect(hvOn(hv.get("FXB")!, "2026-10-21")).toEqual({ date: "2026-05-18", value: 0.05 });
  });

  test("a stale reading breaks the date every other row shares, and a stale skew is not shown", () => {
    const rows = projectRichCheap([screened("FXB", "2026-10-22"), screened("FXA", "2026-10-22"),
      screened("UDN", "2026-08-20", { skew: { date: "2026-08-20", put25: 0.2, call25: 0.18, skew: 0.02 } })]);
    expect(richCheapDates(rows.slice(0, 2)).reading).toMatchObject({ date: "2026-10-22" });
    expect(richCheapDates(rows).reading).toBeNull();
    expect(rows[2]).toMatchObject({ stale: true, skew: null, skewDate: null });
  });

  test("a stale measure on a symbol's history is marked and unranked, and the note says which", () => {
    const dates = sessions(400, "2026-10-23");
    const model = projectIvHistory(payload(dates.map((date) => point(date, 0.2)), {
      coverage: { source: "seed", addedAt: "", backfilledThrough: "2026-10-23", since: dates[0]! },
      stats: { iv30: null, iv90: null, iv365: { value: 0.083, date: "2025-01-17", method: "trade-close", rank: 80, percentile: 80, low: 0.07, high: 0.09,
        samples: 0, windowStart: null } },
    }), prices(dates));
    const stat = (id: string) => model.stats.find((row) => row.id === id)!;
    expect(stat("iv365")).toMatchObject({ value: 0.083, stale: true, rank: null, percentile: null });
    expect(stat("iv365").sessionsBehind).toBeGreaterThan(200);
    expect(stat("hv").stale).toBe(false);
    expect(model.staleNote).toBe("Stale, left out of rank: IV 1Y ATM 2025-01-17 (more than 5 sessions behind 2026-10-23).");
  });
});
