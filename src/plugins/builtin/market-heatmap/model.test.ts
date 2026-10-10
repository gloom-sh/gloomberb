import { describe, expect, test } from "bun:test";
import { heatmapBoardCaption, heatmapMove, heatmapNameCount, regularSessionHeatmapAssets, summarizeHeatmapGroups } from "./model";

function asset(symbol: string, size: number, changePercent: number | null, sector: string | null, industry: string | null = null) {
  return { symbol, size, changePercent: changePercent ?? 0, hasChange: changePercent != null, sector, industry };
}

describe("summarizeHeatmapGroups", () => {
  test("weights each group's move by size over the names that moved, and counts a name with no move only in its size", () => {
    const { groups, board } = summarizeHeatmapGroups([
      asset("BIG", 300, -1, "Tech", "Chips"),
      asset("MID", 100, 3, "Tech", "Software"),
      // No change data: not a flat session, so not in the move or the breadth.
      asset("NEW", 600, null, "Tech", "Software"),
      asset("BANK", 400, 0.5, "Financials", "Banks"),
      asset("ODD", 50, 2, null),
    ], "sector");

    expect(groups.map((group) => group.group)).toEqual(["Tech", "Financials", null]);
    const tech = groups[0]!;
    expect(tech.names).toBe(3);
    expect(tech.size).toBe(1000);
    expect(tech.move).toBeCloseTo((300 * -1 + 100 * 3) / 400, 10);
    expect([tech.up, tech.down, tech.moved]).toEqual([1, 1, 2]);
    expect(tech.best).toEqual({ symbol: "MID", move: 3 });
    expect(tech.worst).toEqual({ symbol: "BIG", move: -1 });
    expect(tech.share).toBeCloseTo(1000 / 1450, 10);
    expect(board.move).toBeCloseTo((-300 + 300 + 200 + 100) / 850, 10);
  });

  test("by industry keeps each industry's sector, and a board without sectors is one group", () => {
    const stocks = [
      asset("A", 200, 1, "Tech", "Chips"),
      asset("B", 100, -2, "Tech", "Software"),
      asset("C", 150, 1, "Energy", "Oil"),
    ];
    expect(summarizeHeatmapGroups(stocks, "industry").groups.map((group) => [group.sector, group.group]))
      .toEqual([["Tech", "Chips"], ["Energy", "Oil"], ["Tech", "Software"]]);

    const etfs = summarizeHeatmapGroups([asset("SPY", 500, 1, null), asset("QQQ", 300, -1, null)], "industry");
    expect(etfs.grouping).toBe("flat");
    expect(etfs.groups).toEqual([etfs.board]);
    expect(etfs.board.move).toBeCloseTo(200 / 800, 10);
  });
});

test("a name the snapshot has no close for has no move until it streams an extended print", () => {
  const noClose = { hasChange: false, changePercent: 0 };
  expect(heatmapMove(noClose)).toBeNull();
  expect(heatmapMove({ ...noClose, changePercent: 3.97, extendedSession: "PRE" })).toBe(3.97);
  expect(heatmapMove({ ...noClose, changePercent: Number.NaN, extendedSession: "PRE" })).toBeNull();
  // Or until its quote reports the completed session's move; a flat number alone is not one.
  expect(heatmapMove({ ...noClose, changePercent: -0.52, regularChangePercent: -0.52 })).toBe(-0.52);
  expect(heatmapMove({ ...noClose, regularChangePercent: null })).toBeNull();
});

test("read by its regular session, a board taken outside it keeps only the moves dated to the completed session", () => {
  const dated = { symbol: "NVDA", hasChange: true, price: 229.28, changePercent: -0.52, regularChangePercent: -0.52 };
  // A last sale from a session nobody named: no move, and no price either.
  const undated = { symbol: "ZZZ", hasChange: true, price: 41.3, changePercent: 1.9, regularChangePercent: null };
  const noClose = { symbol: "NEW", hasChange: false, price: 12, changePercent: 0, regularChangePercent: null };
  const board = [dated, undated, noClose];
  const regular = regularSessionHeatmapAssets(board, "POST");
  expect(regular[0]).toBe(dated);
  expect(regular[1]).toMatchObject({ hasChange: false, price: 0 });
  expect(heatmapMove(regular[1]!)).toBeNull();
  expect(regular[2]).toBe(noClose);
  // While the session trades every move is the session's.
  expect(regularSessionHeatmapAssets(board, "REGULAR")).toBe(board);
  expect(regularSessionHeatmapAssets([dated, noClose], "CLOSED")).toEqual([dated, noClose]);
});

test("the board's caption dates the session and the snapshot in New York time, through daylight saving, and gives way in a narrow footer", () => {
  const saturday = Date.parse("2026-10-10T10:00:00Z");
  const closed = { topCount: 500, regularSessionDate: "2026-10-09", fetchedAt: Date.parse("2026-10-09T22:15:15Z") };
  expect(heatmapBoardCaption(closed, { now: saturday, checked: "2m ago" })).toBe("top 500 · Oct 9 session · snapshot 18:15 ET · checked 2m ago");
  // Put together the next morning, the snapshot says which day.
  expect(heatmapBoardCaption({ ...closed, fetchedAt: Date.parse("2026-10-10T09:58:32Z") }, { now: saturday }))
    .toBe("top 500 · Oct 9 session · snapshot Oct 10 05:58 ET");
  // While the session trades (here in standard time) there is no completed session to name.
  const december = Date.parse("2026-12-04T15:31:00Z");
  expect(heatmapBoardCaption({ topCount: 100, regularSessionDate: null, fetchedAt: december }, { now: december + 60_000 }))
    .toBe("top 100 · snapshot 10:31 ET");
  expect(heatmapBoardCaption({ topCount: 100, fetchedAt: december }, { now: december + 86_400_000 }))
    .toBe("top 100 · snapshot Dec 4 10:31 ET");
  // The check goes first, then the snapshot; the count stays while it fits.
  expect(heatmapBoardCaption(closed, { now: saturday, checked: "2m ago", maxWidth: 45 })).toBe("top 500 · Oct 9 session · snapshot 18:15 ET");
  expect(heatmapBoardCaption(closed, { now: saturday, checked: "2m ago", maxWidth: 30 })).toBe("top 500 · Oct 9 session");
  // After a failed refresh the last good check is what a reader needs, so the snapshot goes first.
  expect(heatmapBoardCaption(closed, { now: saturday, checked: "2m ago", failed: true, maxWidth: 45 })).toBe("top 500 · Oct 9 session · checked 2m ago");
  expect(heatmapBoardCaption(closed, { now: saturday, maxWidth: 4 })).toBeNull();
});

test("a saved name count is read from the dialog's text or a number, and anything else is all 500", () => {
  expect([heatmapNameCount("100"), heatmapNameCount(150), heatmapNameCount("500")]).toEqual([100, 150, 500]);
  expect([heatmapNameCount(undefined), heatmapNameCount("250"), heatmapNameCount(""), heatmapNameCount("top")]).toEqual([500, 500, 500, 500]);
});
