import { describe, expect, test } from "bun:test";
import { fitDataTableColumns } from "../../../components/ui/data-table/column-fit";
import { hiddenTableColumns } from "../../../components/ui/table-layout";
import type { PricePoint, Quote } from "../../../types/financials";
import { SECTOR_COLLECTIONS } from "./sector-data";
import {
  applySectorReload,
  buildSectorColumns,
  computeTrailingReturn,
  overlayLiveSectorQuote,
  sectorReturnTargetDate,
  sectorRowFollowsQuote,
  sortRows,
  type SectorRow,
} from "./sector-model";

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

  test("the feed covers a board ranked on the completed session through pre-market, not past the open", () => {
    // Pre-market prints are held back on purpose, so reloading for them would change nothing.
    expect(sectorRowFollowsQuote(row, quote(215, "2026-09-11T12:00:00Z", { marketState: "PRE" }))).toBe(true);
    // A regular print of the next session is what only a reload can roll the board to.
    expect(sectorRowFollowsQuote(row, quote(215, "2026-09-11T14:00:00Z", { marketState: "REGULAR" }))).toBe(false);
  });
});

describe("background sector reloads", () => {
  const loaded = (price: number): Partial<SectorRow> => ({ price, returnAsOfDate: "2026-09-10", quoteIssue: null });
  const rows = [
    { etf: "XLK", name: "Technology", price: 200, loading: false, returnAsOfDate: "2026-09-10", quoteIssue: null, returnIntegrity: {} },
    { etf: "XLE", name: "Energy", price: 90, loading: false, returnAsOfDate: "2026-09-10", quoteIssue: null, returnIntegrity: {} },
  ] as SectorRow[];

  test("a reload that changed nothing hands back the same rows so the board is not rewritten", () => {
    expect(applySectorReload(rows, new Map([["XLK", loaded(200)], ["XLE", loaded(90)]]), true)).toBe(rows);
  });

  test("a fund the reload missed keeps its row in the same session, and only changed rows are replaced", () => {
    const next = applySectorReload(rows, new Map([["XLK", loaded(201)], ["XLE", null]]), true);
    expect(next[0]).toMatchObject({ price: 201, loading: false });
    expect(next[1]).toBe(rows[1]);
    const rolled = applySectorReload(rows, new Map([["XLK", { ...loaded(201), returnAsOfDate: "2026-09-11" }], ["XLE", null]]), true);
    expect(rolled[1]).toMatchObject({ price: null, quoteUnavailable: true });
  });
});

describe("the board's columns in a narrow pane", () => {
  // What the desktop and the web draw in a body `cells` wide, as the table fits it (the terminal scrolls to the rest).
  const drawn = (width: number, cells: number, sortColumnId: string | null = "changePercent") => {
    const fitted = fitDataTableColumns(buildSectorColumns(width), cells, { anchoredColumns: 1, sortColumnId });
    return { ids: fitted.map((column) => column.id).join(" "), name: fitted[0]!.width, hidden: hiddenTableColumns(fitted).join(" ") };
  };
  const longest = Math.max(...SECTOR_COLLECTIONS.flatMap((collection) => collection.items.map((item) => item.name.length)));

  test("1Y leaves before a sector's name is cut, and 1M never leaves for the name", () => {
    // The browser's first screen, 53 cells: six columns left the name ten, and two rows both read "Consumer …".
    const firstScreen = drawn(53, 53.75);
    expect(firstScreen).toMatchObject({ ids: "name etf price changePercent return1M", hidden: "1Y" });
    expect(firstScreen.name).toBeGreaterThanOrEqual(longest);
    // Every name whole wherever all six columns show.
    for (const width of [61, 64, 70]) {
      expect(drawn(width, width)).toMatchObject({ ids: "name etf price changePercent return1M return1Y", hidden: "" });
      expect(buildSectorColumns(width)[0]!.width).toBeGreaterThanOrEqual(longest);
    }
    // Between the two, 1Y waits behind More and the names are whole.
    for (const width of [52, 56, 58]) {
      const fitted = drawn(width, width + 0.75);
      expect(fitted).toMatchObject({ hidden: "1Y" });
      expect(fitted.name).toBeGreaterThanOrEqual(longest);
    }
    // A phone keeps 1M as it did: the name has what 1Y's leaving gives it and no more.
    expect(drawn(48, 48.75)).toMatchObject({ ids: "name etf price changePercent return1M", hidden: "1Y" });
    expect(drawn(46, 46.875)).toMatchObject({ ids: "name etf price changePercent return1M", hidden: "1Y" });
    // Sorted by 1Y, it is the column that stays.
    expect(drawn(53, 53.75, "return1Y")).toMatchObject({ ids: "name etf price changePercent return1Y", hidden: "1M" });
  });
});
