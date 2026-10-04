import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { projectMacroDays } from "./model";

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
});
