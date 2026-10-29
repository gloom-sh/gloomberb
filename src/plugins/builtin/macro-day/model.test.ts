import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { formatMacroDayMove, macroDayStats, matchesSurprise, projectMacroDays } from "./model";

/** Weekday closes from `from` to `to`, skipping `closed`; each close is 1% above the one before unless `closes` says otherwise. */
function weekdays(from: string, to: string, closed: string[], closes: Record<string, number> = {}): PricePoint[] {
  const points: PricePoint[] = [];
  let close = 100;
  for (let day = Date.parse(`${from}T00:00:00Z`); day <= Date.parse(`${to}T00:00:00Z`); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6 || closed.includes(date)) continue;
    close = closes[date] ?? close * 1.01;
    points.push({ date: new Date(`${date}T00:00:00Z`), close });
  }
  return points;
}

describe("macro-day alignment", () => {
  test("reads each release on its own close, a Good Friday release on the next session, and drops one across a data gap", () => {
    // 2026-04-03 is Good Friday (market shut); 2026-04-15 and 16 have no bars although the market was open.
    const history = weekdays("2026-03-30", "2026-04-24", ["2026-04-03", "2026-04-15", "2026-04-16"], {
      "2026-04-01": 120, "2026-04-06": 108,
    });
    const model = projectMacroDays(history, { symbol: "TEST", lookbackYears: 1, coveredThrough: "2026-12-31", releases: [
      { kind: "cpi", date: "2026-04-01" },
      { kind: "jobs", date: "2026-04-03" },
      { kind: "fomc", date: "2026-04-15" },
      // Weekend: no release lands there, so nothing is read.
      { kind: "cpi", date: "2026-04-18" },
    ] });
    const before = (date: string) => history.find((point) => point.date.toISOString().slice(0, 10) === date)!.close;
    expect(model.events.map((event) => [event.kind, event.date, event.session])).toEqual([
      ["jobs", "2026-04-03", "2026-04-06"],
      ["cpi", "2026-04-01", "2026-04-01"],
    ]);
    expect(model.events[0]!.move).toBeCloseTo(108 / before("2026-04-02") - 1, 12);
    expect(model.events[1]!.move).toBeCloseTo(120 / before("2026-03-31") - 1, 12);
    // Release sessions are out of the normal days.
    expect(model.normal.count).toBe(history.length - 1 - 2);
    expect(model.byKind.fomc.count).toBe(0);

    // A close stamped at its New York time, 20:30 UTC, names the same session as a UTC-midnight label.
    const stamped = projectMacroDays(history.map((point) => ({ ...point, date: new Date(point.date.getTime() + 20.5 * 3_600_000) })),
      { symbol: "TEST", lookbackYears: 1, coveredThrough: "2026-12-31", releases: [{ kind: "cpi", date: "2026-04-01" }] });
    expect(stamped.events.map((event) => event.session)).toEqual(["2026-04-01"]);
  });

  test("opens the window at the first session of a history that starts after the nominal start", () => {
    // Five years of daily bars counted back from 2026-10-09 begin on 2021-10-11; the lists are covered through 2026-10-01.
    const options = { symbol: "TEST", lookbackYears: 5, coveredThrough: "2026-10-01" };
    const releases = [{ kind: "jobs", date: "2021-10-08" }, { kind: "cpi", date: "2021-10-13" }] as const;
    const history = weekdays("2021-10-11", "2026-10-09", []);
    const model = projectMacroDays(history, { ...options, releases });
    expect(model.start).toBe("2021-10-11");
    expect(model.asOf).toBe("2026-10-01");
    expect(model.events.map((event) => [event.kind, event.date])).toEqual([["cpi", "2021-10-13"]]);
    // Moves start the session after the first bar and stop at the covered end; the CPI session is not a normal day.
    const moved = history.filter((point) => { const date = point.date.toISOString().slice(0, 10); return date > "2021-10-11" && date <= "2026-10-01"; });
    expect(model.normal.count).toBe(moved.length - 1);

    // A history that starts well before the nominal start keeps the nominal start.
    const longer = projectMacroDays(weekdays("2020-06-01", "2026-10-09", []), { ...options, releases: [{ kind: "jobs", date: "2021-10-01" }, { kind: "cpi", date: "2021-10-13" }] });
    expect(longer.start).toBe("2021-10-01");
    expect(longer.events.map((event) => event.date)).toEqual(["2021-10-13"]);
  });
});

describe("macro-day earnings overlap", () => {
  test("marks a release day that is the company's own earnings reaction and counts it in no figure", () => {
    const history = weekdays("2026-03-02", "2026-04-17", [], { "2026-03-06": 130, "2026-03-11": 90, "2026-04-13": 70 });
    const options = { symbol: "TEST", lookbackYears: 1, coveredThrough: "2026-12-31", releases: [
      { kind: "jobs", date: "2026-03-06" }, { kind: "cpi", date: "2026-03-11" }, { kind: "fomc", date: "2026-03-18" }, { kind: "cpi", date: "2026-04-10" },
    ] } as const;
    const plain = projectMacroDays(history, options);
    const model = projectMacroDays(history, { ...options, earnings: [
      { date: "2026-03-06", timing: "bmo" }, // before the open: reacts on the jobs day
      { date: "2026-03-10", timing: "amc" }, // after the close the day before: reacts on the CPI day
      { date: "2026-03-17", timing: null }, // no time on record: either session, so the FOMC day too
      { date: "2026-04-10", timing: "amc", reactionSession: "2026-04-13" }, // after the close on a CPI day: the CPI day is clean
    ] });
    expect(model.events.map((event) => [event.kind, event.date, event.earnings])).toEqual([
      ["cpi", "2026-04-10", false], ["fomc", "2026-03-18", true], ["cpi", "2026-03-11", true], ["jobs", "2026-03-06", true],
    ]);
    // Only the clean CPI day is left in the release figures; the others are in the Earnings row, still against the normal day.
    expect(plain.byKind.cpi.count).toBe(2);
    expect(model.byKind.cpi.count).toBe(1);
    expect(model.byKind.cpi.mean).toBeCloseTo(model.events[0]!.move, 12);
    expect([model.byKind.jobs.count, model.byKind.fomc.count, model.allEvents.count, model.earnings.count]).toEqual([0, 0, 1, 3]);
    const flagged = model.events.filter((event) => event.earnings);
    expect(model.earnings.meanAbs).toBeCloseTo(flagged.reduce((sum, event) => sum + Math.abs(event.move), 0) / 3, 12);
    expect(flagged.every((event) => event.multiple != null && event.multiple > 0)).toBe(true);
    // An earnings day is not a normal day either: the baseline is the one the plain study has.
    expect(model.normal).toEqual(plain.normal);
  });
});

describe("macro-day surprises", () => {
  test("keeps each release's figures and sums up the days a surprise filter keeps", () => {
    const history = weekdays("2026-09-01", "2026-10-23", [], { "2026-10-09": 95, "2026-10-14": 104 });
    const hot = { event: "Inflation Rate YoY", actual: "3.7%", forecast: "3.6%", prior: "3.4%", surprise: "hot" as const };
    const model = projectMacroDays(history, { symbol: "EWZ", lookbackYears: 1, coveredThrough: "2026-10-23", releases: [
      { kind: "cpi", date: "2026-09-11", figures: { ...hot, actual: "3.4%", forecast: "3.4%", surprise: "in-line" } },
      { kind: "ipca", date: "2026-10-09", figures: { event: "IPCA m/m", actual: "0.82%", forecast: "0.73%", prior: "-0.32%", surprise: "hot" } },
      { kind: "cpi", date: "2026-10-14", figures: hot },
      // Before the kept calendar: a release day with no figures.
      { kind: "fomc", date: "2026-09-16" },
    ] });
    expect(model.events.map((event) => [event.kind, event.figures?.surprise ?? null])).toEqual([
      ["cpi", "hot"], ["ipca", "hot"], ["fomc", null], ["cpi", "in-line"],
    ]);
    const hotDays = model.events.filter((event) => matchesSurprise(event, "hot"));
    expect(hotDays.map((event) => event.date)).toEqual(["2026-10-14", "2026-10-09"]);
    expect(model.events.filter((event) => matchesSurprise(event, "all"))).toHaveLength(4);
    const summary = macroDayStats(hotDays, model.normal.meanAbs);
    expect(summary.count).toBe(2);
    expect(summary.hitRate).toBe(0.5);
    // IPCA days are summed up on their own: the US figures and the normal day are the ones a list without them gives.
    expect(model.kinds).toEqual(["cpi", "jobs", "fomc", "ipca"]);
    expect(model.byKind.ipca.count).toBe(1);
    const usOnly = projectMacroDays(history, { symbol: "EWZ", lookbackYears: 1, coveredThrough: "2026-10-23",
      releases: model.events.filter((event) => event.kind !== "ipca").map(({ kind, date }) => ({ kind, date })) });
    expect(usOnly.kinds).toEqual(["cpi", "jobs", "fomc"]);
    expect([model.normal, model.allEvents, model.byKind.cpi]).toEqual([usOnly.normal, usOnly.allEvents, usOnly.byKind.cpi]);
  });
});

describe("macro-day moves on a yield", () => {
  test("reads a Treasury yield index's move as the change in the yield, in basis points, and a price's as a return", () => {
    // ^TNX's level is the 10-year yield in percent: 5.24 to 5.28 is +4bp, not +0.76%.
    const closes = { "2026-10-01": 5.24, "2026-10-02": 5.28, "2026-10-05": 5.10 };
    const history = weekdays("2026-09-28", "2026-10-09", [], closes);
    const options = { lookbackYears: 1, coveredThrough: "2026-12-31", releases: [{ kind: "jobs", date: "2026-10-02" }] } as const;
    const yieldDays = projectMacroDays(history, { ...options, symbol: "^TNX" });
    expect(yieldDays.basis).toBe("yield");
    expect(yieldDays.events[0]!.move).toBeCloseTo(0.04, 12);
    expect(formatMacroDayMove(yieldDays.events[0]!.move, yieldDays.basis)).toBe("+4.0bp");
    // An average size has no sign; a move that rounds to nothing has none either.
    expect(formatMacroDayMove(0.065, "yield", { signed: false })).toBe("6.5bp");
    // Under a column headed bp, the number alone.
    expect(formatMacroDayMove(0.04, "yield", { unit: false })).toBe("+4.0");
    expect(formatMacroDayMove(-0.0004, "yield")).toBe("0.0bp");

    const priceDays = projectMacroDays(history, { ...options, symbol: "SPY" });
    expect(priceDays.basis).toBe("return");
    expect(formatMacroDayMove(priceDays.events[0]!.move, priceDays.basis)).toBe("+0.76%");
  });
});
