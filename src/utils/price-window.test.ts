import { expect, test } from "bun:test";
import { WindowBeforeFirstBarError } from "../sources/history-coverage";
import { createTestDataProvider } from "../test-support/data-provider";
import { loadPriceWindowHistory, priceWindowBarStart, priceWindowInterval, priceWindowText, readPriceWindow } from "./price-window";

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
  // A slashed date that reads two ways names the dotted day-first form that is read one way.
  expect(() => readPriceWindow("05/11/2025", undefined, now))
    .toThrow('Invalid --from "05/11/2025". Use the window\'s start as a year (2007) or a date (2008-09-15, or day first as 15.9.2008), such as --from 2007.');
});

test("a date that has begun where the reader is, east of UTC, is no start still ahead", () => {
  // 05:00 on 23 Oct in Tokyo, still 22 Oct in UTC.
  const tokyo = new Date("2026-10-22T20:00:00Z");
  expect(readPriceWindow("2026-10-23", undefined, tokyo, "Asia/Tokyo")).toEqual({ from: "2026-10-23", to: "2026-10-23" });
  expect(priceWindowText({ from: "2026-10-23", to: "2026-10-23" }, tokyo, "Asia/Tokyo")).toBe("2026-10-23 to today");
  expect(() => readPriceWindow("2026-10-23", undefined, tokyo, "America/New_York")).toThrow("--from 2026-10-23 has not started yet");
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

test("a window wholly before the first bar says the day the bars start, and any other failure stays what it was", async () => {
  const day = (date: string, close: number) => ({ date: new Date(`${date}T00:00:00Z`), close });
  // The service answers BTC-USD from 2003 to 2006 as an upstream failure, which read as an outage to retry.
  const provider = createTestDataProvider({
    getDetailedPriceHistoryWithMetadata: async (_symbol, _exchange, start, end, interval) => {
      if (start < new Date("2014-09-01T00:00:00Z")) throw new Error("Gloom's data service did not answer");
      return { points: [day("2014-09-17", 457.33), day("2014-09-18", 424.44)], resolution: interval };
    },
    getPriceHistoryWithMetadata: async () => ({ points: [day("2014-09-01", 386.94), day("2014-10-01", 338.32)], resolution: "1mo" }),
  });
  const read = (from: string, to: string) => loadPriceWindowHistory(provider, "BTC-USD", "", { from, to });
  const before = await read("2003-01-01", "2006-12-31").catch((error: unknown) => error);
  expect(before).toBeInstanceOf(WindowBeforeFirstBarError);
  expect((before as Error).message).toBe("No bars before 2014-09-17 for BTC-USD.");
  // A window that reaches the first bar failed for another reason: that failure is the answer.
  expect(await read("2013-01-01", "2015-12-31").catch((error: unknown) => (error as Error).message)).toBe("Gloom's data service did not answer");
});
