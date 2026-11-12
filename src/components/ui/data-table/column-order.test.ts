import { expect, test } from "bun:test";
import { columnDropBoundary, orderColumns, rememberColumnOrder, rowAnchorColumnCount } from "./column-order";

const column = (id: string, label = id.toUpperCase(), width = 8) => ({ id, label, width });
const ids = (columns: readonly { id: string }[]) => columns.map((entry) => entry.id);

test("a remembered order keeps the anchored columns first and a column added since after its neighbour", () => {
  const columns = ["ticker", "last", "chg", "vol", "pe"].map((id) => column(id));
  // Remembered before the pane added P/E; it still follows VOL wherever VOL went.
  expect(ids(orderColumns(columns, ["vol", "ticker", "chg", "last"], 1))).toEqual(["ticker", "vol", "pe", "chg", "last"]);
  expect(orderColumns(columns, ["ticker", "last", "chg"], 1)).toBe(columns);
});

test("a move in a narrow pane leaves the place of a column it does not show", () => {
  const saved = ["ticker", "last", "name", "chg", "vol"];
  // NAME is dropped at this width; VOL moves before LAST.
  const next = rememberColumnOrder(saved, ["ticker", "last", "chg", "vol"], ["ticker", "vol", "last", "chg"]);
  expect(next).toEqual(["ticker", "vol", "name", "last", "chg"]);
  // Wide again, NAME is back where it was, between the moved columns.
  const wide = ["ticker", "last", "name", "chg", "vol"].map((id) => column(id));
  expect(ids(orderColumns(wide, next, 1))).toEqual(["ticker", "vol", "name", "last", "chg"]);
  // A first move remembers the table as it was drawn, ids it had not seen included.
  expect(rememberColumnOrder(undefined, ["ticker", "last", "chg"], ["ticker", "chg", "last"])).toEqual(["ticker", "chg", "last"]);
});

test("a narrow mark before the row's name stays with it", () => {
  expect(rowAnchorColumnCount([column("ticker"), column("last")])).toBe(1);
  expect(rowAnchorColumnCount([column("dot", "", 1), column("ticker"), column("last")])).toBe(2);
  expect(rowAnchorColumnCount([column("rank", "#", 3), column("name", "NAME", 20), column("last")])).toBe(2);
});

test("scrolled under a frozen first column, the columns it covers take no drop", () => {
  // TICKER is frozen at 30-40 on screen; LAST (10-20) is under it and CHG% (36-46) half under it.
  const spans = [{ start: 30, end: 40 }, { start: 10, end: 20 }, { start: 36, end: 46 }, { start: 47, end: 57 }];
  // Over the frozen column: the first gap that shows, before CHG%, judged by the part of it past the frozen edge.
  expect(columnDropBoundary(spans, 32, 1, 40)).toBe(2);
  expect(columnDropBoundary(spans, 44, 1, 40)).toBe(3);
});
