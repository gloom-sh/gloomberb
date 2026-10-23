import { expect, test } from "bun:test";
import { priceWindowBarStart, priceWindowInterval, priceWindowText, readPriceWindow } from "./price-window";

const now = new Date("2026-10-22T12:00:00Z");

test("years run from 1 Jan to 31 Dec, dates are taken as typed, and the window stops at today", () => {
  expect(readPriceWindow("2007", "2009", now)).toEqual({ from: "2007-01-01", to: "2009-12-31" });
  expect(readPriceWindow("2008-09-15", "15.03.2009", now)).toEqual({ from: "2008-09-15", to: "2009-03-15" });
  expect(readPriceWindow("2025", undefined, now)).toEqual({ from: "2025-01-01", to: "2026-10-22" });
  expect(readPriceWindow("2026", "2026", now)).toEqual({ from: "2026-01-01", to: "2026-10-22" });
  expect(readPriceWindow(undefined, undefined, now)).toBeNull();
  expect(priceWindowText({ from: "2007-01-01", to: "2009-12-31" }, now)).toBe("2007 to 2009");
  expect(priceWindowText({ from: "2008-09-15", to: "2026-10-22" }, now)).toBe("2008-09-15 to today");
});

test("a window that cannot be read names the option and what to type", () => {
  expect(() => readPriceWindow(undefined, "2009", now)).toThrow("--to needs a --from: --from 2007 --to 2009.");
  expect(() => readPriceWindow("2009", "2007", now)).toThrow("--from 2009 is after --to 2007. The window runs from the earlier to the later, such as --from 2007 --to 2009.");
  expect(() => readPriceWindow("2027", undefined, now)).toThrow("--from 2027 has not started yet");
  expect(() => readPriceWindow("2007x", undefined, now)).toThrow('Invalid --from "2007x"');
});

test("a date that has begun where the reader is, east of UTC, is no start still ahead", () => {
  const zone = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    // 05:00 on 23 Oct in Tokyo, still 22 Oct in UTC.
    const tokyo = new Date("2026-10-22T20:00:00Z");
    expect(readPriceWindow("2026-10-23", undefined, tokyo)).toEqual({ from: "2026-10-23", to: "2026-10-23" });
    expect(priceWindowText({ from: "2026-10-23", to: "2026-10-23" }, tokyo)).toBe("2026-10-23 to today");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("a weekly or monthly window starts with the week or month its first date falls in", () => {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  expect(day(priceWindowBarStart("2008-09-17", "1wk"))).toBe("2008-09-15");
  expect(day(priceWindowBarStart("2008-09-21", "1wk"))).toBe("2008-09-15");
  expect(day(priceWindowBarStart("1990-09-15", "1mo"))).toBe("1990-09-01");
  expect(day(priceWindowBarStart("2008-09-17", "1d"))).toBe("2008-09-17");
});

test("bars get coarser as the window grows: daily to five years, weekly to twenty, then monthly", () => {
  expect(priceWindowInterval({ from: "2007-01-01", to: "2009-12-31" })).toBe("1d");
  expect(priceWindowInterval({ from: "2000-01-01", to: "2009-12-31" })).toBe("1wk");
  expect(priceWindowInterval({ from: "1980-01-01", to: "2009-12-31" })).toBe("1mo");
});
