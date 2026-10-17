import { expect, test } from "bun:test";
import { barsPerYear, barsPerYearLabel } from "./bars-per-year";

const days = (from: string, count: number, skip: (weekday: number) => boolean = () => false) => {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, index) => start + index * 86_400_000).filter((time) => !skip(new Date(time).getUTCDay()));
};

test("weekend observations make a series 24/7; an exchange calendar, however shifted, stays at 252 sessions", () => {
  expect(barsPerYear(days("2025-01-01", 60))).toBe(365);
  expect(barsPerYear(days("2025-01-01", 60, (weekday) => weekday === 0 || weekday === 6))).toBe(252);
  // Sunday to Thursday, and bars stamped late on the previous evening, have a Sunday but no Saturday.
  expect(barsPerYear(days("2025-01-01", 60, (weekday) => weekday === 5 || weekday === 6))).toBe(252);
  // One stray weekend print in a long exchange history does not change the convention.
  const sessions = days("2023-01-02", 520, (weekday) => weekday === 0 || weekday === 6);
  expect(barsPerYear([...sessions, Date.parse("2024-06-01")])).toBe(252);
  expect(barsPerYear(["2025-01-03", new Date("2025-01-04"), Date.parse("2025-01-05")])).toBe(365);
  expect(barsPerYearLabel(365)).toBe("365 bars/yr");
});
