import { expect, test } from "bun:test";
import { parseFredGraphCsv } from "./fred-public";
import { latestRate, rateChangeBp, yieldStat, type BriefYieldRow } from "./rates";

test("latestRate keeps the newest print and the one before it", () => {
  expect(latestRate([
    { date: "2026-10-01", value: 4.1 },
    { date: "2026-10-02", value: null },
    { date: "2026-10-03", value: 4.18 },
  ])).toEqual({ value: 4.18, previous: 4.1 });
  expect(latestRate([{ date: "2026-10-03", value: 6.3 }])).toEqual({ value: 6.3, previous: null });
  expect(latestRate([])).toBeNull();
});

test("rateChangeBp is the rounded move in basis points", () => {
  expect(rateChangeBp(4.21, 4.19)).toBe(2);
  expect(rateChangeBp(4.19, 4.21)).toBe(-2);
  expect(rateChangeBp(6.3, null)).toBeNull();
});

test("public FRED csv keeps the mortgage prints and skips missing weeks", () => {
  const rows = parseFredGraphCsv(
    "observation_date,MORTGAGE30US\n2026-09-24,7.03\n2026-10-01,.\n2026-10-08,7.28\n",
    "MORTGAGE30US",
  );
  expect(latestRate(rows)).toEqual({ value: 7.28, previous: 7.03 });
  expect(() => parseFredGraphCsv("<!DOCTYPE html><html>", "MORTGAGE30US")).toThrow("unavailable");
});

test("yieldStat prints the level and the basis-point move", () => {
  const row: BriefYieldRow = { id: "us10y", label: "10Y", level: { value: 4.21, previous: 4.19 } };
  expect(yieldStat(row)).toEqual({ id: "us10y", label: "10Y", value: "4.21%", detail: "+2bp", tone: "positive" });
  expect(yieldStat({ id: "mtg30", label: "30Y MTG", level: null })).toEqual({ id: "mtg30", label: "30Y MTG", value: "--" });
});
