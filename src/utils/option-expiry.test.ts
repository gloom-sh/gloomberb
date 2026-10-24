import { describe, expect, test } from "bun:test";
import type { OptionContract } from "../types/financials";
import {
  daysToExpiry, expirationOptionSeconds, expiredExpiryText, findListedExpiry, formatDaysToExpiry, isLiveOptionExpiry, liveDefaultExpiry,
  liveOptionExpiries, nextLiveExpiry, optionExpiryCloseMs, parseOptionExpiration, readOptionExpiration,
} from "./option-expiry";

const at = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

test("--expiration reads a calendar date as UTC midnight and Unix seconds as they are", () => {
  expect(parseOptionExpiration("2028-01-21")).toBe(1832025600);
  expect(parseOptionExpiration("1832025600")).toBe(1832025600);
  for (const date of ["2028-1-21", "2028/01/21", "2028年1月21日"]) expect(parseOptionExpiration(date)).toBe(1832025600);
  // The calendar has no 30 February; the Date constructor would roll it into March.
  for (const bad of ["2028-02-30", "2028/02/30", "21-01-2028", "1.8e9", "-5", "0", "", "soon", "1832025600000"]) {
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

test("an expiry written day first gets the date to type, and one that names no date gets only the formats", () => {
  expect(() => expirationOptionSeconds("22/10/2028")).toThrow('Invalid --expiration "22/10/2028". Use YYYY-MM-DD (2028-01-21), DD.MM.YYYY, Jan 21 2028, 21 January 2028 or Unix seconds (1832025600). Type --expiration 2028-10-22 for 22/10/2028.');
  expect(() => expirationOptionSeconds("soon", "expiry")).toThrow(/Unix seconds \(1832025600\)\.$/);
});

describe("an expiry is live until its last session closes on the listing's clock", () => {
  const friday = at("2026-10-23");
  const listed = [friday, at("2026-10-30"), at("2026-11-06")];
  const instant = (iso: string) => Date.parse(iso);

  test("Friday's expiry lasts to its 16:00 New York close, and is gone over the weekend and before Monday's open", () => {
    expect(isLiveOptionExpiry(friday, instant("2026-10-23T19:59:59Z"), "ARCA")).toBe(true);
    expect(isLiveOptionExpiry(friday, instant("2026-10-23T20:00:00Z"), "ARCA")).toBe(false);
    // Saturday morning in Europe, still Friday evening in New York: UTC midnight has not passed there either.
    expect(isLiveOptionExpiry(friday, instant("2026-10-24T03:00:00Z"), "ARCA")).toBe(false);
    expect(isLiveOptionExpiry(friday, instant("2026-10-26T13:00:00Z"), "ARCA")).toBe(false);
    for (const now of ["2026-10-24T05:24:00Z", "2026-10-26T13:00:00Z"]) {
      expect(liveOptionExpiries(listed, instant(now), "ARCA")).toEqual(listed.slice(1));
    }
    // A chain read without a venue trades on the US calendar.
    expect(optionExpiryCloseMs(friday)).toBe(instant("2026-10-23T20:00:00Z"));
    expect(formatDaysToExpiry(friday, instant("2026-10-23T20:30:00Z"))).toBe("expired");
  });

  test("a holiday-shortened week ends at the published early close, and a holiday expiry with the session before it", () => {
    // Thanksgiving week: Friday 27 Nov 2026 closes at 13:00 New York.
    expect(isLiveOptionExpiry(at("2026-11-27"), instant("2026-11-27T17:59:00Z"), "NYSE")).toBe(true);
    expect(isLiveOptionExpiry(at("2026-11-27"), instant("2026-11-27T18:00:00Z"), "NYSE")).toBe(false);
    // Good Friday 3 Apr 2026 has no session: an expiry dated then last traded Thursday.
    expect(optionExpiryCloseMs(at("2026-04-03"), "NASDAQ")).toBe(instant("2026-04-02T20:00:00Z"));
    expect(expiredExpiryText(at("2026-04-03"), [at("2026-04-10")], instant("2026-04-04T12:00:00Z"), { flag: "expiration" }))
      .toBe("expired on 2 Apr; nearest live: 10 Apr (--expiration 2026-04-10)");
  });

  test("a listing abroad closes on its own venue's clock", () => {
    expect(optionExpiryCloseMs(friday, "XETRA")).toBe(instant("2026-10-23T15:40:00Z"));
    expect(optionExpiryCloseMs(friday, "JPX")).toBe(instant("2026-10-23T06:30:00Z"));
  });

  test("a default chain on a lapsed expiry gives way to the nearest live one, and an expired date names it", () => {
    const contract = { expiration: friday } as OptionContract;
    const chain = { calls: [contract], puts: [], expirationDates: listed };
    expect(liveDefaultExpiry(chain, instant("2026-10-23T19:00:00Z"), "ARCA")).toBeUndefined();
    expect(liveDefaultExpiry(chain, instant("2026-10-24T05:24:00Z"), "ARCA")).toBe(at("2026-10-30"));
    expect(liveDefaultExpiry({ ...chain, expirationDates: [friday] }, instant("2026-10-24T05:24:00Z"), "ARCA")).toBeNull();
    expect(expiredExpiryText(friday, listed, instant("2026-10-24T05:24:00Z"), { exchange: "ARCA", flag: "expiration" }))
      .toBe("expired on 23 Oct; nearest live: 30 Oct (--expiration 2026-10-30)");
    expect(nextLiveExpiry(at("2026-10-30"), listed, instant("2026-10-24T05:24:00Z"))).toBe(at("2026-11-06"));
  });
});
