import { describe, expect, test } from "bun:test";
import type { AnalystResearchData, CorporateActionsData } from "../../../types/financials";
import { dividendYearDetail, dividendYearLabel, dividendYears, dividendYearSpan, earningsQuarters, quartersEpsBasis, splitMarks } from "./event-charts";
import { buildEventRows } from "./event-model";

describe("the Earnings view's quarters", () => {
  const today = "2098-11-24";
  const estimates: AnalystResearchData = { symbol: "TEST", recommendations: [], ratings: [],
    earningsEstimates: [{ date: "2098-12-31", period: "current_quarter", average: 0.6, currency: "USD" }],
    revenueEstimates: [{ date: "2098-12-31", period: "current_quarter", average: 11.2e9, currency: "USD" }] };
  // Fifteen reported quarters, Mar 2095 to Sep 2098, oldest first as a source may send them, alternately a beat and a miss.
  const reported = Array.from({ length: 15 }, (_, index) => {
    const year = 2095 + Math.floor(index / 4);
    const [end, report] = ([["03-31", "04-28"], ["06-30", "07-28"], ["09-30", "10-28"], ["12-31", "01-28"]] as const)[index % 4]!;
    const eps = Number((1 + index / 100).toFixed(2));
    return { date: `${index % 4 === 3 ? year + 1 : year}-${report}`, dateType: "announcement" as const, currency: "USD",
      fiscalPeriod: `${year}-${end.slice(0, 2)}`, epsActual: eps, epsEstimate: Number((eps + (index % 2 ? -0.02 : 0.02)).toFixed(2)) };
  });
  const quarters = (actions: Partial<CorporateActionsData>) => earningsQuarters(buildEventRows({ symbol: "TEST", currency: "USD", dividends: [], splits: [], earnings: [], ...actions },
    estimates, null, "USD"), today);

  test("the next report leads with the consensus for its quarter, then the last twelve reported, newest first", () => {
    const list = quarters({ earnings: [...reported,
      // A quarter's end on record is no report of its own.
      { date: "2098-09-30", dateType: "fiscal-period-end", epsActual: 1.2, currency: "USD" },
      { date: "2099-02-10", dateType: "announcement", epsEstimate: 0.61, currency: "USD", dateStatus: "confirmed" }] });
    expect(list).toHaveLength(13);
    expect(list[0]).toMatchObject({ upcoming: true, date: "2099-02-10", period: "Dec 2098", axisLabel: "Dec '98", estimate: 0.61, revenueEstimate: 11.2e9 });
    expect(list[0]!.eps).toBeUndefined();
    expect(list.slice(1).map((quarter) => quarter.upcoming)).toEqual(Array(12).fill(false));
    expect(list[1]).toMatchObject({ date: "2098-10-28", period: "Sep 2098", axisLabel: "Sep '98", eps: 1.14, estimate: 1.16 });
    expect(list.at(-1)!.period).toBe("Dec 2095");
    expect(list.map((quarter) => quarter.date)).toEqual([...list.map((quarter) => quarter.date)].sort().reverse());
  });

  test("with no report dated, the quarter analysts estimate next is the upcoming one, not dated yet", () => {
    const list = quarters({ earnings: reported.slice(-2) });
    expect(list[0]).toMatchObject({ upcoming: true, date: "2098-12-31", period: "Dec 2098", estimate: 0.6, detail: "not dated yet" });
    // Nothing is ahead when the earliest quarter estimated is already reported.
    expect(quarters({ earnings: [{ date: "2099-01-30", dateType: "announcement", currency: "USD", fiscalPeriod: "2098-12", epsActual: 0.7, epsEstimate: 0.6 }] })
      .map((quarter) => quarter.upcoming)).toEqual([false]);
  });
});

describe("the Earnings view's DETAIL", () => {
  const today = "2098-11-24";
  const quarter = (index: number, epsBasis: "gaap" | "adjusted") => ({ date: `2098-0${index + 1}-28`, dateType: "announcement" as const, currency: "USD",
    fiscalPeriod: `2097-${String(index * 3 + 3).padStart(2, "0")}`, epsActual: 1 + index / 10, epsEstimate: 1,
    epsBasis, epsActualSource: "filing" as const });

  test("says what the figures do not: a basis only where it is not the one the EPS heading names, never the beat", () => {
    const list = earningsQuarters(buildEventRows({ symbol: "TEST", currency: "USD", dividends: [], splits: [], earnings: [
      quarter(0, "gaap"), quarter(1, "adjusted"), quarter(2, "adjusted"), quarter(3, "adjusted"),
      { date: "2099-02-10", dateType: "announcement", epsEstimate: 0.61, currency: "USD", dateStatus: "confirmed", epsBasis: "adjusted", epsAnalysts: 17, time: "After Hours" },
    ] }, null, null, "USD"), today);
    expect(quartersEpsBasis(list)).toBe("adjusted");
    // The report to come keeps its date's status, time and analysts.
    expect(list[0]!.detail).toBe("confirmed, After Hours, 17 analysts");
    // Newest first: three on the table's basis say nothing, the GAAP one says so; SURPRISE and the detail have the beat.
    expect(list.slice(1).map((entry) => entry.detail)).toEqual(["", "", "", "GAAP"]);
  });
});

describe("the Dividends view's years", () => {
  const today = "2026-11-24";
  const paid = (exDate: string, amount: number, special = false) => ({ exDate, amount,
    ...(special ? { parts: [{ amount, special: true, type: "special", form: { url: "", publishedOn: exDate } }] } : {}) });

  test("each year sums what was paid, the current one so far, each whole year against the one before", () => {
    const years = dividendYears([
      paid("2026-03-10", 0.3), paid("2025-03-10", 0.25), paid("2025-09-10", 0.25), paid("2024-03-10", 0.4), paid("2024-09-10", 0.1, true),
    ], today);
    expect(years.map((year) => [dividendYearLabel(year), year.total, year.payments, year.special, year.partial, year.change])).toEqual([
      ["2026 YTD", 0.3, 1, 0, true, undefined],
      ["2025", 0.5, 2, 0, false, 0],
      ["2024", 0.5, 2, 0.1, false, undefined],
    ]);
    expect(years.map(dividendYearDetail)).toEqual(["so far", "", "incl. special"]);
  });

  test("a year is summed, and compared with the one before, only on one basis: the history's, or as published", () => {
    const published = (exDate: string, amount: number) => ({ exDate, amount,
      parts: [{ amount, special: false, type: "interim", form: { url: "", publishedOn: exDate } }] });
    const years = dividendYears([
      paid("2023-03-01", 0.025), paid("2023-09-01", 0.025), paid("2024-03-01", 0.027007), paid("2024-09-01", 0.027007),
      // A filing's amounts before the spin-off, as published: summed with each other, not set against the history's.
      published("2025-03-03", 0.18), published("2025-09-02", 0.18),
      paid("2026-06-01", 0.027007), published("2026-09-01", 0.18),
    ], "2027-01-15", [{ date: "2026-10-01", terms: "VYLR spin-off" }]);
    expect(years.map((year) => [dividendYearLabel(year), year.total == null ? null : Number(year.total.toFixed(6)), dividendYearDetail(year)])).toEqual([
      ["2026", null, "2 payments on different bases, not summed · VYLR spin-off"],
      ["2025", 0.36, "as published"],
      ["2024", 0.054014, ""],
      ["2023", 0.05, ""],
    ]);
    expect(years.map((year) => (year.change == null ? null : Number(year.change.toFixed(4))))).toEqual([null, null, 0.0803, null]);
    // A year paid on two bases has no total but was paid: the span runs 2023 to 2026.
    expect(dividendYearSpan(years)).toBe(4);
  });

  /** AAPL paid nothing from 1996 to 2011: sixteen blank bars and rows squeezed the years it pays. */
  test("a run of years with no dividend is one gap, broken where a split went ex, so the split is said", () => {
    const dividends = [paid("1995-05-10", 0.1), paid("2012-08-10", 0.4), paid("2013-02-10", 0.4)];
    const plain = dividendYears(dividends, today);
    expect(plain.map(dividendYearLabel)).toEqual(["2013", "2012", "1996-2011", "1995"]);
    expect(dividendYearDetail(plain[2]!)).toBe("no dividend for 16 years");
    expect(dividendYearSpan(plain)).toBe(19);
    const splits = splitMarks(buildEventRows({ symbol: "TEST", currency: "USD", earnings: [], dividends,
      splits: [{ date: "2005-02-28", fromFactor: 1, toFactor: 2 }, { date: "2013-06-09", fromFactor: 1, toFactor: 7 },
        { date: "2014-06-09", fromFactor: 1, toFactor: 4 }] }, null, null, "USD"));
    const marked = dividendYears(dividends, today, splits);
    expect(marked.map(dividendYearLabel)).toEqual(["2013", "2012", "2006-2011", "2005", "1996-2004", "1995"]);
    expect(marked.map(dividendYearDetail)).toEqual(["7-for-1 split", "", "no dividend for 6 years", "no dividend · 2-for-1 split", "no dividend for 9 years", ""]);
    expect(dividendYearSpan(marked)).toBe(19);
  });
});
