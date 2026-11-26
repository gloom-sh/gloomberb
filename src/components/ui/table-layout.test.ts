import { describe, expect, test } from "bun:test";
import {
  buildTableGridTemplateColumns,
  dropColumnsToFit,
  fitColumnsToWidth,
  fitTableCellText,
  fitTableColumns,
  fitTableHeaderText,
  getTableWidth,
  hasMeaningfulTableHorizontalOverflow,
  hiddenTableColumnDisclosure,
  hiddenTableColumnText,
  hiddenTableColumns,
  tableColumnFitFloor,
  tableColumnStarts,
  tableColumnWidth,
  tableRevealLeft,
} from "./table-layout";

describe("table layout", () => {
  test("keeps track of width-dropped columns through repeated fitting and column resizing", () => {
    const columns = [{ id: "ticker", label: "Ticker", width: 8 }, { id: "week", label: "1W", width: 8 }, { id: "year", label: "YTD", width: 8 }];
    const first = dropColumnsToFit(columns, 20, ["year"]);
    const second = dropColumnsToFit(first.map((column) => ({ ...column, width: 9 })), 13, ["week"]);
    expect(hiddenTableColumns(first)).toEqual(["YTD"]);
    expect(hiddenTableColumns(second)).toEqual(["YTD", "1W"]);
    expect(hiddenTableColumns(columns)).toEqual([]);
  });
  test("detects only meaningful horizontal table overflow", () => {
    const tableWidth = getTableWidth([
      { width: 12 },
      { width: 8 },
    ]);

    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, 0)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth - 1)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth - 2)).toBe(true);
  });

  test("supports tables without inter-column gaps", () => {
    const tableWidth = getTableWidth([
      { width: 12 },
      { width: 8 },
    ], 0);
    const noPaddingWidth = getTableWidth([
      { width: 12 },
      { width: 8 },
    ], 0, 0);

    expect(tableWidth).toBe(22);
    expect(noPaddingWidth).toBe(20);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth, 0)).toBe(false);
    expect(hasMeaningfulTableHorizontalOverflow(tableWidth, tableWidth - 1, 0)).toBe(true);
  });

  test("widens a column that cannot fit its own header plus the sort indicator", () => {
    expect(tableColumnWidth({ width: 4, label: "Time" })).toBe(6);
    expect(tableColumnWidth({ width: 4, label: "AS OF" })).toBe(7);
    expect(tableColumnWidth({ width: 12, label: "SECTOR" })).toBe(12);
    expect(getTableWidth([{ width: 2, label: "OI" }, { width: 4, label: "ENDS" }], 1, 0)).toBe(12);
  });

  test("budgets an extra gap where a right-aligned column meets a left-aligned one", () => {
    const columns = [
      { width: 4, align: "right" },
      { width: 6, align: "left" },
      { width: 3 },
      { width: 5, align: "right" },
      { width: 5, align: "right" },
    ];
    // Only the right-to-left seam gets the extra cell; right-to-right does not.
    expect(getTableWidth(columns, 1, 0)).toBe(4 + 1 + 1 + 6 + 1 + 3 + 1 + 5 + 1 + 5 + 1);
    expect(tableColumnStarts(columns, 1)).toEqual([0, 6, 13, 17, 23]);
    // Tables packed without gaps stay packed.
    expect(getTableWidth(columns, 0, 0)).toBe(23);
  });

  test("drops columns in order until the rest fit, an entry with several ids all at once", () => {
    const columns = ["a", "b", "c", "d", "e"].map((id) => ({ id, width: 8, align: "right" }));
    const ids = (width: number, order: Parameters<typeof dropColumnsToFit>[2]) =>
      dropColumnsToFit(columns, width, order).map((column) => column.id).join("");
    const fits = (count: number) => getTableWidth(columns.slice(0, count));

    expect(ids(fits(5), ["a", "b"])).toBe("abcde");
    expect(ids(fits(4), ["a", "b"])).toBe("bcde");
    expect(ids(fits(3), ["a", "b", "c"])).toBe("cde");
    // A pair leaves together, even when dropping the first alone would have fit.
    expect(ids(fits(4), [["a", "b"], "c"])).toBe("cde");
    // Columns not in the order stay, so the table can still overflow.
    expect(ids(fits(1), ["a"])).toBe("bcde");
  });

  test("a table that cuts at its edge keeps whole columns: the listed ones leave first, then the last, never the kept", () => {
    const columns = ["id", "name", "last", "chg", "vol", "asof"].map((id) => ({ id, label: id.toUpperCase(), width: 8, align: "right" }));
    const shown = (width: number, options?: Parameters<typeof fitColumnsToWidth>[2]) => {
      const fitted = fitColumnsToWidth(columns, width, options);
      return { ids: fitted.map((column) => column.id).join(" "), hidden: hiddenTableColumns(fitted).join(" ") };
    };
    const room = (count: number) => getTableWidth(columns.slice(0, count));

    // Everything fits, by the table's own measure of an overflow (a cell over is none): the same array, nothing marked.
    expect(fitColumnsToWidth(columns, room(6) - 1)).toBe(columns);
    // No order: the trailing columns leave, and the table names them in its own order.
    expect(shown(room(4))).toEqual({ ids: "id name last chg", hidden: "VOL ASOF" });
    // An order goes first, least needed first; a pair leaves together though one of it would have made room.
    expect(shown(room(5), { dropOrder: ["name", "vol"] })).toEqual({ ids: "id last chg vol asof", hidden: "NAME" });
    expect(shown(room(5), { dropOrder: [["name", "vol"]] })).toEqual({ ids: "id last chg asof", hidden: "NAME VOL" });
    // Past the order, the unlisted columns leave from the last back, so nothing is ever left to cut.
    expect(shown(room(2), { dropOrder: ["name", "vol"] })).toEqual({ ids: "id last", hidden: "NAME CHG VOL ASOF" });
    // The columns that name the row and the sorted one stay whatever the order says.
    expect(shown(room(3), { dropOrder: ["name", "vol"], identifier: ["id", "asof"], sorted: "name" })).toEqual({ ids: "id name asof", hidden: "LAST CHG VOL" });
    // The date the figures are as of leaves after the other columns, unless the pane's order names it.
    const dated = columns.map((column) => column.id === "asof" ? { ...column, label: "As of" } : column);
    expect(fitColumnsToWidth(dated, room(4)).map((column) => column.id).join(" ")).toBe("id name last asof");
    expect(fitColumnsToWidth(dated, room(4), { dropOrder: ["asof"] }).map((column) => column.id).join(" ")).toBe("id name last chg");
    // Narrower than what must stay: nothing is left out, and the table scrolls with every column as it did.
    expect(fitColumnsToWidth(columns, room(2) - 4, { identifier: ["id"], sorted: "asof" })).toBe(columns);
    expect(fitColumnsToWidth(columns, 4)).toBe(columns);
    // A width not measured yet fits nothing.
    expect(fitColumnsToWidth(columns, 0)).toBe(columns);
  });

  test("a fit keeps what a row means by column id: its sets whole, its identifier wherever it stands, and a figure beside it", () => {
    // A mirrored board: two fields a side around the column that names the row, as an option chain's strike is.
    const columns = ["cLast", "cBid", "strike", "pBid", "pLast", "asof"].map((id) => ({ id, label: id === "asof" ? "As of" : id.toUpperCase(), width: 8, align: "right" }));
    const order = [["cLast", "pLast"], ["cBid", "pBid"]] as const;
    const room = (count: number) => getTableWidth(columns.slice(0, count));
    const ids = (width: number, options: Parameters<typeof fitColumnsToWidth>[2]) => {
      const fitted = fitColumnsToWidth(columns, width, options);
      return fitted === columns ? "scrolls" : fitted.map((column) => column.id).join(" ");
    };
    // A set leaves whole, and the identifier stays though it is not first: the first column is no row's name here.
    expect(ids(room(5), { dropOrder: order, identifier: ["strike"] })).toBe("cBid strike pBid asof");
    // Sorted by one of a set, the whole set stays and the next one gives way instead.
    expect(ids(room(5), { dropOrder: order, identifier: ["strike"], sorted: "pLast" })).toBe("cLast strike pLast asof");
    // The same sets and identifier whatever order the reader put the columns in.
    const moved = [columns[4]!, columns[2]!, columns[0]!, columns[5]!, columns[3]!, columns[1]!];
    expect(fitColumnsToWidth(moved, room(5), { dropOrder: order, identifier: ["strike"] }).map((column) => column.id).join(" ")).toBe("strike asof pBid cBid");
    // The last figures never leave for the date to stay: the date goes, then nothing more can.
    expect(ids(room(3), { dropOrder: order, identifier: ["strike"] })).toBe("cBid strike pBid");
    expect(ids(room(2), { dropOrder: order, identifier: ["strike"] })).toBe("scrolls");
    // Sorted by one set and too narrow for it beside the identifier: every column, scrolling, not half a set.
    expect(ids(room(3), { dropOrder: [["cLast", "pLast", "asof"], ["cBid", "pBid"]], identifier: ["strike"], sorted: "cLast" })).toBe("scrolls");
  });

  test("sets that share a column leave or stay as one, whether or not any of it is kept", () => {
    const columns = ["id", "a", "b", "c", "value"].map((id) => ({ id, label: id.toUpperCase(), width: 8, align: "right" }));
    const room = (count: number) => getTableWidth(columns.slice(0, count));
    const ids = (width: number, options: Parameters<typeof fitColumnsToWidth>[2]) => {
      const fitted = fitColumnsToWidth(columns, width, options);
      return fitted === columns ? "scrolls" : fitted.map((column) => column.id).join(" ");
    };
    const shared = [["a", "b"], ["b", "c"]] as const;
    // Room for three. The first set gone alone left C without the B it is a set with: the two go as one.
    expect(ids(room(3), { dropOrder: shared, identifier: ["id"] })).toBe("id value");
    expect(hiddenTableColumns(fitColumnsToWidth(columns, room(3), { dropOrder: shared, identifier: ["id"] }))).toEqual(["A", "B", "C"]);
    // Kept by one of them, all three stay, and where they do not fit the table scrolls.
    expect(ids(room(4), { dropOrder: shared, identifier: ["id"], sorted: "c" })).toBe("id a b c");
    expect(ids(room(3), { dropOrder: shared, identifier: ["id"], sorted: "c" })).toBe("scrolls");
    // A later set joins the two it shares a column with, and a row is not left with its name alone.
    expect(ids(room(3), { dropOrder: [["a", "b"], ["c", "value"], ["b", "c"]], identifier: ["id"] })).toBe("scrolls");
    // Sets that share only a column this table does not have stay apart, each the columns of it the table has.
    expect(ids(room(4), { dropOrder: [["a", "date"], ["c", "date"]], identifier: ["id"] })).toBe("id b c value");
  });

  test("the line names apart what More draws again and what only a wider pane shows", () => {
    const columns = ["id", "last", "cost", "month", "avg"].map((id) => ({ id, label: id.toUpperCase(), width: 8, align: "right" }));
    // The pane left two out for its own width; the table's fit then leaves one more.
    const pane = dropColumnsToFit(columns, getTableWidth(columns.slice(0, 3)), ["cost", "month"]);
    expect(hiddenTableColumnDisclosure(pane)).toEqual({ restorable: null, pane: "2 hidden · COST, MONTH" });
    const fitted = fitColumnsToWidth(pane, getTableWidth(columns.slice(0, 2)));
    expect(fitted.map((column) => column.id).join(" ")).toBe("id last");
    expect(hiddenTableColumnDisclosure(fitted)).toEqual({ restorable: "1 hidden · AVG", pane: "2 need a wider pane · COST, MONTH" });
    // The table's fit alone reads as it always did, and the terminal's one line still counts them all.
    expect(hiddenTableColumnDisclosure(fitColumnsToWidth(columns, getTableWidth(columns.slice(0, 3))))).toEqual({ restorable: "2 hidden · MONTH, AVG", pane: null });
    expect(hiddenTableColumnText(fitted)).toBe("3 hidden · COST, MONTH, AVG");
    expect(hiddenTableColumnDisclosure(columns)).toBeNull();
  });

  test("a column set to grow narrows to its floor before any column leaves, and a figure is never narrowed", () => {
    // TICKER 8, NAME 30 set to grow, then three figures of 10: 74 cells as set.
    const columns = [
      { id: "ticker", label: "TICKER", width: 8, align: "left" },
      { id: "name", label: "NAME", width: 30, align: "left", flexGrow: 1 },
      ...["last", "cap", "asof"].map((id) => ({ id, label: id.toUpperCase(), width: 10, align: "right" })),
    ];
    const drawn = (width: number) => {
      const fitted = fitColumnsToWidth(columns, width);
      return { widths: fitted.map((column) => `${column.id} ${column.width}`).join(", "), hidden: hiddenTableColumns(fitted).join(" ") };
    };
    expect(tableColumnFitFloor(columns[1]!)).toBe(15);
    expect(tableColumnFitFloor(columns[2]!)).toBe(10);
    // Ten cells short: the name gives them up, and every column is still there.
    expect(drawn(getTableWidth(columns) - 10)).toEqual({ widths: "ticker 8, name 20, last 10, cap 10, asof 10", hidden: "" });
    // Past the name's floor a whole column leaves, and the name takes back the room that frees.
    expect(drawn(getTableWidth(columns) - 18)).toEqual({ widths: "ticker 8, name 23, last 10, cap 10", hidden: "ASOF" });
  });

  test("whatever the widths and the order, a fit either draws columns that do not overflow or leaves the table as it was", () => {
    let seed = 7;
    const next = (bound: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % bound; };
    for (let round = 0; round < 300; round += 1) {
      const columns = Array.from({ length: 2 + next(12) }, (_, index) => ({
        id: `c${index}`, label: "X".repeat(1 + next(12)), width: 3 + next(24), align: next(2) ? "right" : "left",
        ...(next(4) === 0 ? { flexGrow: 1 } : {}),
      }));
      const ids = columns.map((column) => column.id);
      const identifier = [ids[next(ids.length)]!];
      const sorted = next(2) ? ids[next(ids.length)]! : null;
      const listed = ids.filter(() => next(3) === 0).sort(() => next(3) - 1);
      // Some of the order's entries are sets of two, and some of those share a column with an earlier entry.
      const dropOrder: (string | string[])[] = [];
      while (listed.length) {
        const before = dropOrder.flat();
        dropOrder.push(before.length && next(4) === 0 ? [before[next(before.length)]!, listed.shift()!]
          : listed.length > 1 && next(3) === 0 ? listed.splice(0, 2) : listed.shift()!);
      }
      const width = 10 + next(160);
      const fitted = fitColumnsToWidth(columns, width, { identifier, sorted, dropOrder });
      const has = (id: string) => fitted.some((column) => column.id === id);
      // Nothing drawn past the edge, unless the table is left whole to scroll.
      if (hasMeaningfulTableHorizontalOverflow(getTableWidth(fitted), width, 1)) expect(fitted).toBe(columns);
      // Whole columns in the table's order, the identifier and the sorted one among them, and no set drawn in part.
      expect(fitted.map((column) => column.id)).toEqual(ids.filter(has));
      expect([...identifier, ...sorted ? [sorted] : []].every(has)).toBe(true);
      for (const step of dropOrder) if (typeof step !== "string") expect(new Set(step.map(has)).size).toBe(1);
      // A row keeps a column beside its identifier.
      if (ids.length > 1) expect(fitted.length).toBeGreaterThan(1);
      // Only a column set to grow is narrowed, and never under its floor.
      for (const column of fitted) {
        const set = columns.find((candidate) => candidate.id === column.id)!;
        expect(tableColumnWidth(column)).toBeGreaterThanOrEqual(tableColumnFitFloor(set));
        if (!("flexGrow" in set)) expect(column.width).toBe(set.width);
      }
    }
  });

  test("a terminal table gives up the blank past its text before it cuts a name or pushes a column past the edge", () => {
    const widths = (columns: { width: number }[]) => columns.map((column) => column.width);
    const hint = { least: 3, whole: 8 };
    // A watchlist: TICKER 12, LAST 9, CHG% 8, MCAP 12, VOL 10, each holding less than it is set to.
    const board = [
      { id: "ticker", label: "TICKER", width: 12 },
      { id: "last", label: "LAST", width: 9, align: "right" },
      { id: "change", label: "CHG%", width: 8, align: "right" },
      { id: "cap", label: "MCAP", width: 12, align: "right" },
      { id: "volume", label: "VOL", width: 10, align: "right" },
    ];
    const held = [6, 6, 6, 5, 6];
    // Wide enough for every column as set: as the pane set them.
    expect(widths(fitTableColumns(board, held, getTableWidth(board), 1, 1, hint))).toEqual([12, 9, 8, 12, 10]);
    // 36 cells held TICKER, LAST and CHG% as set. Down to their text and headers MCAP shows too, beside "⇧→";
    // the three cells left go back to the first columns (too few for "more ⇧→") and VOL waits past the edge.
    const narrow = fitTableColumns(board, held, 36, 1, 1, hint);
    expect(widths(narrow)).toEqual([9, 7, 7, 6, 6]);
    expect(tableColumnStarts(narrow)[3]! + 1 + 6 + hint.least).toBe(36);
    // All five fit at 45, what is left given back a cell at a time from the left.
    expect(widths(fitTableColumns(board, held, 45, 1, 1, hint))).toEqual([10, 7, 7, 7, 7]);

    // A name cut while the figures beside it hold blank takes that blank first.
    const movers = [
      { id: "symbol", label: "TICKER", width: 10 },
      { id: "name", label: "NAME", width: 6 },
      { id: "last", label: "LAST", width: 10, align: "right" },
      { id: "change", label: "CHG%", width: 8, align: "right" },
    ];
    expect(widths(fitTableColumns(movers, [4, 30, 6, 7], 38, 1, 1, hint))).toEqual([8, 11, 6, 7]);
    // A drawn cell that gives no width (null) keeps its column as set, and the name gets less.
    expect(widths(fitTableColumns(movers, [null, 30, 6, 7], 38, 1, 1, hint))).toEqual([10, 9, 6, 7]);
    // A headline set to the pane's edge and cut there: the cell a narrower rank gives back would not lengthen
    // it, so the table stays as set rather than move.
    const news = [
      { id: "rank", label: "#", width: 4, align: "right" },
      { id: "time", label: "TIME GMT+1", width: 12 },
      { id: "title", label: "HEADLINE", width: 24 },
    ];
    expect(widths(fitTableColumns(news, [2, 9, 80], getTableWidth(news) - 1, 1, 1))).toEqual([4, 12, 24]);
    // An empty table is as wide as its headers, so it never says there are more columns.
    expect(getTableWidth(fitTableColumns(board, [0, 0, 0, 0, 0], 40, 1, 1, hint))).toBeLessThanOrEqual(40);
  });

  test("a last column the set widths end at the edge, its padding past it, may end there with a name grown", () => {
    // A movers board at 66 cells: EVENT ends at the edge as set, and LAST has a cell of blank for the name.
    const movers = [["#", 3], ["TICKER", 8], ["NAME", 6], ["LAST", 10], ["CHG%", 8], ["PRE VOL", 9], ["RVOL", 6], ["EVENT", 7]]
      .map(([label, width], index) => ({ id: String(index), label: String(label), width: Number(width), align: index >= 3 && index <= 6 ? "right" : "left" }));
    expect(fitTableColumns(movers, [2, 4, 34, 9, 8, 6, 5, 4], 66, 1, 1, { least: 3, whole: 8 }).map((column) => column.width))
      .toEqual([3, 8, 7, 9, 8, 9, 6, 7]);
  });

  test("a fit never trades a column the set widths show whole for more of a cut name", () => {
    const hint = { least: 3, whole: 8 };
    // A maturity table at 39 cells: its last column ends at the edge, only its blank past it cut. Pushing it
    // out would give the name three more cells.
    const maturities = [
      { id: "label", label: "MATURITY", width: 15 },
      { id: "value", label: "PRINCIPAL", width: 11, align: "right" },
      { id: "share", label: "% TOTAL", width: 9, align: "right" },
    ];
    expect(fitTableColumns(maturities, [18, 6, 5], 39, 1, 1, hint).map((column) => column.width)).toEqual([15, 11, 9]);
    // Eight columns at 80 cells, each at its header's width but the cut company name: they stay.
    const ranking = [8, 15, 7, 8, 7, 8, 8, 10].map((width, index) => ({
      id: String(index), label: ["TICKER", "COMPANY", "SCORE", "ROLE", "STAKE", "BUYERS", "BOUGHT", "LAST BUY"][index]!, width,
      align: [0, 1, 3].includes(index) ? "left" : "right",
    }));
    expect(fitTableColumns(ranking, [4, 23, 2, 8, 4, 1, 7, 10], 80, 1, 1).map((column) => column.width))
      .toEqual([8, 15, 7, 8, 7, 8, 8, 10]);
  });

  test("a last text column the hint's whole form would leave a few cells of is pushed out by the shown columns", () => {
    // The volatility board at 34 cells: INDEX, LEVEL, 1D % and AS OF, which cannot show whole.
    const columns = [
      { id: "id", label: "INDEX", width: 8 },
      { id: "value", label: "LEVEL", width: 9, align: "right" },
      { id: "change", label: "1D %", width: 9, align: "right" },
      { id: "date", label: "AS OF", width: 12 },
    ];
    const fitted = fitTableColumns(columns, [5, 6, 6, 10], 34, 1, 1, { least: 3, whole: 8 });
    // The three it shows are whole at their set widths, so the table stays as set.
    expect(fitted.map((column) => column.width)).toEqual([8, 9, 9, 12]);
    // AS OF starts three cells from the edge: fewer than its label, so the rows leave them blank beside "⇧→".
    expect(34 - tableColumnStarts(fitted)[3]! - 1).toBeLessThan("AS OF".length);
  });

  test("scrolls a wide table to centre one column, stopping at a column edge past a frozen first column", () => {
    // A tenor column and nine moneyness columns, ATM the sixth, in a 40-cell pane.
    const columns = [{ id: "tenor", width: 10 }, ...Array.from({ length: 9 }, (_, index) => ({ id: String(index), width: 7 }))];
    const shared = { columns, columnIndex: 5, viewportWidth: 40, maxLeft: 44 };
    expect(tableRevealLeft({ ...shared, frozenFirstColumn: true })).toBe(24);
    expect(tableRevealLeft(shared)).toBe(28);
    // Past the right end it stops at the last scroll position; a table that fits does not move.
    expect(tableRevealLeft({ ...shared, columnIndex: 9 })).toBe(44);
    expect(tableRevealLeft({ ...shared, maxLeft: 0 })).toBe(0);
  });

  test("marks clipped cells so a cut number cannot read as a smaller value", () => {
    expect(fitTableCellText("2026-08-17", 9, "right")).toBe("2026-08-\u2026");
    expect(fitTableCellText("globenewswire", 10)).toBe("globenews\u2026");
    expect(fitTableCellText("12.5", 6, "right")).toBe("  12.5");
  });

  test("keeps a blank cell between adjacent headers without shortening a label", () => {
    expect(fitTableHeaderText("OI", 4, "right")).toBe(" OI ");
    expect(fitTableHeaderText("ENDS", 6, "left")).toBe("ENDS  ");
    // A header that already fills its column keeps every character.
    expect(fitTableHeaderText("WEIGHT \u25bc", 8, "right")).toBe("WEIGHT \u25bc");
    expect(fitTableHeaderText("ALLOCATION", 10, "left", false)).toBe("ALLOCATION");
  });

  test("keeps non-flex web table columns fixed", () => {
    const template = buildTableGridTemplateColumns([
      { width: 4, align: "right" },
      { width: 40, flexGrow: 1 },
      { width: 24 },
      { width: 5, align: "right" },
    ]);

    expect(template).toBe(
      // The flexible column follows a right-aligned one, so its track carries the extra gap cell.
      "minmax(calc(4 * var(--cell-w)), calc(4 * var(--cell-w))) minmax(calc(15 * var(--cell-w)), 41fr) minmax(calc(8 * var(--cell-w)), calc(24 * var(--cell-w))) minmax(calc(5 * var(--cell-w)), calc(5 * var(--cell-w)))",
    );
  });

  test("keeps proportional web table columns when no column is flexible", () => {
    const template = buildTableGridTemplateColumns([
      { width: 12 },
      { width: 8, align: "right" },
    ]);

    expect(template).toBe("minmax(calc(8 * var(--cell-w)), 12fr) minmax(calc(8 * var(--cell-w)), 8fr)");
  });

  test("keeps fixed web table columns when fill width is disabled", () => {
    const template = buildTableGridTemplateColumns([
      { width: 12 },
      { width: 8, align: "right" },
    ], false);

    expect(template).toBe("minmax(calc(8 * var(--cell-w)), calc(12 * var(--cell-w))) minmax(calc(8 * var(--cell-w)), calc(8 * var(--cell-w)))");
  });
});
