import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../../../types/financials";
import { computeTrailingReturn, overlayLiveSectorQuote, sectorReturnTargetDate, sortRows, type SectorRow } from "./sector-model";

const point = (date: string, close: number): PricePoint => ({ date: new Date(date), close });

describe("sector calendar price returns", () => {
  test("a shorter history cannot stand in for the requested year", () => {
    const history = [point("2026-06-01", 195.76), point("2026-09-09", 187.87)];
    expect(computeTrailingReturn(history, "1Y")).toBeNull();
  });

  test("uses the shared as-of date rather than each history's final bar", () => {
    const history = [point("2026-08-10", 90), point("2026-08-11", 100), point("2026-09-09", 100)];
    const current = [...history, point("2026-09-10", 104)];
    for (const source of [history, current]) {
      const result = computeTrailingReturn(source, "1M", 105, "2026-09-10");
      expect(result?.value).toBeCloseTo(16.6666667);
      expect(result?.startDate).toBe("2026-08-10");
      expect(result?.endDate).toBe("2026-09-10");
    }
    // Without a quote for that session, yesterday's close cannot replace it.
    expect(computeTrailingReturn(history, "1M", null, "2026-09-10")).toBeNull();
  });

  test("clamps month ends and leap years, allowing a nearby preceding holiday close", () => {
    expect(sectorReturnTargetDate("2024-02-29", "1Y")).toBe("2023-02-28");
    expect(sectorReturnTargetDate("2026-03-31", "1M")).toBe("2026-02-28");
    const result = computeTrailingReturn([point("2026-02-27", 100), point("2026-03-31", 110)], "1M");
    expect(result).toMatchObject({ startDate: "2026-02-27", endDate: "2026-03-31" });
    expect(result?.value).toBeCloseTo(10);
    expect(computeTrailingReturn([point("2026-02-01", 100), point("2026-03-31", 110)], "1M")).toBeNull();
  });

  test.each(["asc", "desc"] as const)("keeps unavailable window returns last when sorting %s", (direction) => {
    const rows = [{ etf: "missing", return1Y: null }, { etf: "loss", return1Y: -5 }, { etf: "gain", return1Y: 10 }] as SectorRow[];
    expect(sortRows(rows, { columnId: "return1Y", direction }).at(-1)?.etf).toBe("missing");
  });

  test("rejects inconsistent endpoints without substituting an older bar or live quote", () => {
    const baseline = { ...point("2026-08-10", 100), high: 99, low: 98 };
    const end = point("2026-09-10", 110);
    const badStart = computeTrailingReturn([point("2026-08-07", 90), baseline, end], "1M");
    expect(badStart).toMatchObject({ value: null, startDate: "2026-08-10" });
    expect(badStart?.integrity?.sourcePoints[0]?.close).toBe(100);
    const badEnd = computeTrailingReturn([point("2026-08-10", 100), { ...end, high: 105, low: 99 }], "1M", 112);
    expect(badEnd?.value).toBeNull();
    expect(badEnd?.integrity?.sourcePoints[0]?.close).toBe(110);
    // A point-to-point price return does not depend on intermediate closes.
    const cleanEndpoints = computeTrailingReturn([point("2026-08-10", 100),
      { ...point("2026-08-20", 120), high: 105, low: 99 }, end], "1M");
    expect(cleanEndpoints?.value).toBeCloseTo(10);
  });

  test("an invalid newest close cannot reveal an older duplicate or baseline", () => {
    const history = [point("2026-08-07", 90), point("2026-08-10", 100), point("2026-08-10", NaN), point("2026-09-10", 110)];
    expect(computeTrailingReturn(history, "1M")).toBeNull();
  });
});

describe("live sector quotes", () => {
  const row = {
    etf: "XLK", name: "Technology", price: 200, changePercent: 1, return1M: 10, return1Y: 25,
    currency: "USD", loading: false, returnAsOfDate: "2026-09-10", quoteUpdatedAt: Date.parse("2026-09-10T15:00:00Z"),
  } as SectorRow;
  const quote = (price: number, at: string, extra: Partial<Quote> = {}) => ({
    symbol: "XLK", price, change: 0, changePercent: 1.5, currency: "USD", lastUpdated: Date.parse(at), delivery: "stream", ...extra,
  }) as Quote;

  test("a tick in the shared session moves price and day change and keeps the return baselines", () => {
    const live = overlayLiveSectorQuote(row, quote(210, "2026-09-10T16:00:00Z"));
    expect(live).toMatchObject({ price: 210, changePercent: 1.5 });
    // Baselines 200/1.10 and 200/1.25, now measured to 210.
    expect(live.return1M).toBeCloseTo(15.5, 6);
    expect(live.return1Y).toBeCloseTo(31.25, 6);
  });

  test("a print from another session, an older quote or a stale one leaves the snapshot row", () => {
    // The next session's pre-market must not mix into a board ranked on the completed one.
    expect(overlayLiveSectorQuote(row, quote(215, "2026-09-11T12:00:00Z", { marketState: "PRE" }))).toBe(row);
    expect(overlayLiveSectorQuote(row, quote(199, "2026-09-10T14:00:00Z"))).toBe(row);
    expect(overlayLiveSectorQuote(row, quote(210, "2026-09-10T16:00:00Z", { stale: true }))).toBe(row);
  });
});
