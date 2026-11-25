import { expect, test } from "bun:test";
import { buildDividendMetrics, toDividendPayment } from "./client";
import { buildTrailingCashChartPoints } from "./view";
import { trailingCashAt } from "../../../utils/trailing-dividend";

test("cash chart uses complete calendar-year cash totals without inventing historical price yields", () => {
  const payments = Array.from({ length: 25 }, (_, month) => toDividendPayment(
    new Date(Date.UTC(2024, 1 + month, 1)).toISOString().slice(0, 10), 0.5, "USD",
  )!);
  payments.push(toDividendPayment("2027-02-01", 50, "USD")!);
  const points = buildTrailingCashChartPoints(payments.reverse(), new Date("2026-02-01"));
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2025-02-01", 6], ["2026-02-01", 6],
  ]);
  expect(buildTrailingCashChartPoints(payments.slice(1, 3), new Date("2026-09-10"))).toEqual([]);
});

test("cash chart reaches the current zero cash rate after payments stop", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2023-08-04", 0.125, "USD")!,
    toDividendPayment("2024-08-07", 0.125, "USD")!,
  ], new Date("2026-09-10"));
  // The first year holds until the second, three days late, went ex; the last is held through the late
  // grace and goes when the cadence does (two years and 30 days past the first).
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2024-08-04", 0.125], ["2025-09-03", 0], ["2026-09-10", 0],
  ]);
});

test("cash chart drops on each expiry and combines same-day cash and expiries once", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-01-01", 1, "USD")!,
    toDividendPayment("2023-01-01", 1, "USD")!,
    toDividendPayment("2023-04-01", 2, "USD")!,
    toDividendPayment("2024-01-01", 4, "USD")!,
    toDividendPayment("2024-01-01", 5, "USD")!,
  ], new Date("2024-05-01"));
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2023-01-01", 1], ["2023-04-01", 3], ["2024-01-01", 11], ["2024-04-01", 9], ["2024-05-01", 9],
  ]);
});

test("February 29 cash leaves the clamped annual window on March 1 of the following year", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-01-01", 1, "USD")!,
    toDividendPayment("2024-02-28", 2, "USD")!,
    toDividendPayment("2024-02-29", 3, "USD")!,
  ], new Date("2025-03-02"));
  expect(points.slice(-3).map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2025-02-28", 3], ["2025-03-01", 0], ["2025-03-02", 0],
  ]);
});

test("leap-day cash chart retains payments after the clamped February 28 cutoff", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-02-28", 1, "USD")!,
    toDividendPayment("2023-03-01", 4, "USD")!,
    toDividendPayment("2023-07-15", 1, "USD")!,
    toDividendPayment("2023-11-30", 1, "USD")!,
    toDividendPayment("2024-02-29", 1, "USD")!,
  ], new Date("2024-02-29T12:00:00Z"));
  expect(points.at(-1)?.close).toBe(7);
});

test("drifting ex-dates count one payment per period in trailing cash and its chart", () => {
  // SCHD's 2025-09-24 ex-date is a day earlier in the year than 2024-09-25; the 2026-09-28 fixture is four days later.
  const schd = [
    ["2024-06-26", 0.274667], ["2024-09-25", 0.251667], ["2024-12-11", 0.265], ["2025-03-26", 0.249],
    ["2025-06-25", 0.26], ["2025-09-24", 0.26], ["2025-12-10", 0.278], ["2026-03-25", 0.257], ["2026-06-24", 0.253],
    ["2026-09-28", 0.25],
  ].map(([date, amount]) => toDividendPayment(date as string, amount as number, "USD")!);
  const schdPoints = buildTrailingCashChartPoints(schd, new Date("2026-10-01T12:00:00Z"));
  expect(Math.max(...schdPoints.map((point) => point.close))).toBeLessThan(1.1);
  expect(Math.min(...schdPoints.map((point) => point.close))).toBeGreaterThan(1);
  expect(buildDividendMetrics(schd, null, 30, { now: new Date("2025-09-24T20:00:00Z") }).trailingRate).toBeCloseTo(1.034, 9);
  expect(buildDividendMetrics(schd, null, 30, { now: new Date("2026-09-26T20:00:00Z") }).trailingRate).toBeCloseTo(1.048, 9);

  // O's 2025-10-01 and 2025-10-31 ex-dates are both less than a year before 2026-09-30.
  const monthlyDates = ["2025-08-29", "2025-10-01", "2025-10-31", "2025-11-28", "2025-12-31", "2026-01-30", "2026-02-27",
    "2026-03-31", "2026-04-30", "2026-05-29", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
  const monthly = monthlyDates.map((date) => toDividendPayment(date, 0.25, "USD")!);
  expect(buildDividendMetrics(monthly, null, 50, { now: new Date("2026-09-30T20:00:00Z") }).trailingRate).toBeCloseTo(3, 9);
  expect(buildDividendMetrics(monthly, null, 50, { now: new Date("2026-09-29T20:00:00Z") }).trailingRate).toBeCloseTo(3, 9);
});

test("an annual payer whose ex-date slips a few days keeps its trailing cash between the two", () => {
  // Kweichow Moutai: June 25, 2021 and June 30, 2022 are 370 days apart.
  const moutai = [
    ["2019-06-28", 14.539], ["2020-06-24", 17.025], ["2021-06-25", 19.293], ["2022-06-30", 21.675], ["2022-12-27", 21.91],
  ].map(([date, amount]) => toDividendPayment(date as string, amount as number, "CNY")!);
  const points = buildTrailingCashChartPoints(moutai, new Date("2023-01-31T12:00:00Z"));
  const at = (day: string) => points.filter((point) => point.date.toISOString().slice(0, 10) <= day).at(-1)?.close;
  expect(at("2022-06-27")).toBeCloseTo(19.293, 9);
  expect(at("2022-06-30")).toBeCloseTo(21.675, 9);
  expect(Math.min(...points.filter((point) => point.date >= new Date("2020-07-01")).map((point) => point.close)))
    .toBeGreaterThan(17);
  expect(buildDividendMetrics(moutai, null, 1800, { now: new Date("2022-06-28T12:00:00Z") }).trailingRate).toBeCloseTo(19.293, 9);
  // A payer that stops still falls to nothing once the grace has passed.
  const stopped = moutai.filter((payment) => payment.exDate < new Date("2022-01-01"));
  expect(buildDividendMetrics(stopped, null, 1800, { now: new Date("2022-08-15T12:00:00Z") }).trailingRate ?? 0).toBe(0);
});

test("the chart of the past holds a year's cash until a late payment in its slot goes ex, and the latest point is as known", () => {
  // Haier Smart Home (600690): an annual final each summer, its ex-date drifting by weeks, no 1999 dividend,
  // an interim added in November 2025.
  const haier = [
    ["1997-06-16", 0.037879], ["1998-06-08", 0.049453], ["2000-06-20", 0.025253], ["2001-06-21", 0.025253],
    ["2014-06-18", 0.23], ["2015-07-16", 0.246], ["2016-07-26", 0.212], ["2017-08-01", 0.248], ["2018-06-07", 0.342],
    ["2019-08-08", 0.351], ["2020-07-16", 0.375], ["2021-08-23", 0.366], ["2022-08-23", 0.46136], ["2023-08-25", 0.56692],
    ["2024-08-16", 0.80131], ["2025-07-25", 0.96504], ["2025-11-07", 0.2692], ["2026-08-21", 0.89151],
  ].map(([date, amount]) => toDividendPayment(date as string, amount as number, "CNY")!);
  const now = new Date("2026-11-25T12:00:00Z");
  const points = buildTrailingCashChartPoints(haier, now);
  const at = (day: string) => points.filter((point) => point.date.toISOString().slice(0, 10) <= day).at(-1)!.close;
  // As known on the day these read 0: the 2014, 2018 and 2020 finals had left the year and the next had not gone ex.
  expect(at("2015-07-10")).toBe(0.23);
  expect(at("2019-07-15")).toBe(0.342);
  expect(at("2021-08-20")).toBe(0.375);
  // The interim alone read 0.2692 until the 2026 final went ex.
  expect(at("2026-08-01")).toBeCloseTo(0.96504 + 0.2692, 9);
  // No 1999 dividend: the year with nothing paid in its slot still falls to nothing.
  expect(at("1999-12-31")).toBe(0);
  // The latest point is the strip's figure: the 2025 interim has left the year, the 2026 one is not paid yet.
  expect(points.at(-1)!.date).toEqual(now);
  expect(points.at(-1)!.close).toBe(buildDividendMetrics(haier, null, 30, { now }).trailingRate!);
  expect(points.at(-1)!.close).toBe(0.89151);
});

/** An annual payer's finals each July, from 2022, then `later` as given. */
function annualPayer(later: [string, number][]) {
  return [["2022-07-12", 1], ["2023-07-11", 1], ["2024-07-10", 1], ...later]
    .map(([date, amount]) => toDividendPayment(date as string, amount as number, "USD")!);
}

/** The chart's value on each day from `from` to `to`, as the step it holds then. */
function chartDays(points: ReturnType<typeof buildTrailingCashChartPoints>, from: string, to: string): { day: string; close: number }[] {
  const days: { day: string; close: number }[] = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    days.push({ day, close: points.filter((point) => point.date.toISOString().slice(0, 10) <= day).at(-1)!.close });
  }
  return days;
}

test("a final that moved weeks earlier is the year's cash in its predecessor's place, never beside it, when an interim follows", () => {
  // The 2025 final went ex 51 days before the 2024 one's anniversary, and an interim was added in October.
  const payments = annualPayer([["2025-05-20", 1], ["2025-10-15", 0.3]]);
  const points = buildTrailingCashChartPoints(payments, new Date("2026-03-01T12:00:00Z"));
  // As known, the 2025 final superseded the 2024 one; the interim is no slot successor of the 2024 final.
  expect(trailingCashAt(payments, new Date("2025-08-01T00:00:00Z"))).toBe(1);
  for (const { day, close } of chartDays(points, "2025-05-20", "2025-10-14")) expect([day, close]).toEqual([day, 1]);
  for (const { day, close } of chartDays(points, "2025-10-15", "2026-03-01")) expect([day, Number(close.toFixed(9))]).toEqual([day, 1.3]);
});

test("a final that moved weeks earlier with no interim after it reads as known on every day", () => {
  const payments = annualPayer([["2025-05-20", 1], ["2026-05-19", 1]]);
  const now = new Date("2026-08-01T12:00:00Z");
  const points = buildTrailingCashChartPoints(payments, now);
  for (const { day, close } of chartDays(points, "2023-08-01", "2026-07-31")) {
    expect([day, close]).toEqual([day, trailingCashAt(payments, new Date(`${day}T00:00:00Z`))]);
  }
});

test("a cut final that went ex early reads the cut at once, never the old figure beside or instead of it", () => {
  // The 2025 final was cut to 0.40 and went ex in May; an interim of 0.20 followed in October.
  const payments = annualPayer([["2025-05-20", 0.4], ["2025-10-15", 0.2]]);
  const points = buildTrailingCashChartPoints(payments, new Date("2026-03-01T12:00:00Z"));
  for (const { day, close } of chartDays(points, "2025-05-20", "2025-10-14")) expect([day, close]).toEqual([day, 0.4]);
  for (const { day, close } of chartDays(points, "2025-10-15", "2026-03-01")) expect([day, Number(close.toFixed(9))]).toEqual([day, 0.6]);
});
