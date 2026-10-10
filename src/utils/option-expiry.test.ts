import { expect, test } from "bun:test";
import { daysToExpiry, findListedExpiry, formatDaysToExpiry, parseOptionExpiration, readOptionExpiration } from "./option-expiry";

const at = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

test("--expiration reads a calendar date as UTC midnight and Unix seconds as they are", () => {
  expect(parseOptionExpiration("2028-01-21")).toBe(1832025600);
  expect(parseOptionExpiration("1832025600")).toBe(1832025600);
  // The calendar has no 30 February; the Date constructor would roll it into March.
  for (const bad of ["2028-02-30", "2028-1-21", "2028/01/21", "21-01-2028", "1.8e9", "-5", "0", "", "soon", "1832025600000"]) {
    expect(parseOptionExpiration(bad)).toBeNull();
  }
  // A stored setting is a number from the app, or the text the CLI took.
  expect(readOptionExpiration(1832025600)).toBe(1832025600);
  expect(readOptionExpiration("2028-01-21")).toBe(1832025600);
  for (const bad of [Number.NaN, -1, undefined, null, true]) expect(readOptionExpiration(bad)).toBeNull();
});

test("a requested date finds the listed expiry stamped later the same UTC day", () => {
  const listed = [at("2027-12-17"), at("2028-01-21") + 16 * 3600, at("2028-03-17")];
  expect(findListedExpiry(at("2028-01-21"), listed)).toBe(listed[1]);
  expect(findListedExpiry(at("2028-01-20"), listed)).toBeUndefined();
});

test("days to expiry count calendar days from the as-of date, whatever its time of day", () => {
  // Friday's close in New York is already Saturday in some zones; the UTC date decides.
  expect(daysToExpiry(at("2028-01-21"), Date.parse("2026-10-09T19:59:00Z"))).toBe(469);
  expect(daysToExpiry(at("2028-01-21"), Date.parse("2026-10-09T23:59:59Z"))).toBe(469);
  expect(formatDaysToExpiry(at("2026-10-09"), Date.parse("2026-10-09T19:59:00Z"))).toBe("0d");
  expect(formatDaysToExpiry(at("2026-10-09"), Date.parse("2026-10-10T03:00:00Z"))).toBe("expired");
});
