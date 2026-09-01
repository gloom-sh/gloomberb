import { describe, expect, test } from "bun:test";
import {
  buildListRows,
  getListRowsHeight,
  resolveSelectedScrollLine,
  type ListScreenState,
  type ResultItem,
} from "./model";

function makeItem(id: string, category: string, lineCount = 0): ResultItem {
  return {
    id,
    label: id,
    detail: "",
    category,
    kind: "action",
    lines: lineCount > 0
      ? Array.from({ length: lineCount }, (_unused, index) => ({
        segments: [{ text: `${id} line ${index}` }],
      }))
      : undefined,
    action: () => {},
  };
}

function makeListState(results: ResultItem[], selectedIdx = 0): ListScreenState {
  return {
    kind: "root",
    title: "Commands",
    query: "margin",
    selectedIdx,
    hoveredIdx: null,
    results,
    searching: false,
    emptyLabel: "",
    emptyDetail: "",
    footerLeft: "",
    footerRight: "",
  };
}

/** The clamp `CommandBarPanel` applies to the scroll box on every selection. */
function applyScroll(scrollTop: number, target: number, viewportHeight: number): number {
  if (target < 0) return scrollTop;
  if (target < scrollTop) return target;
  if (target >= scrollTop + viewportHeight) return target - viewportHeight + 1;
  return scrollTop;
}

function rowLineRange(
  rows: ReturnType<typeof buildListRows>,
  rowIndex: number,
): { first: number; last: number } {
  const first = resolveSelectedScrollLine(rows, rowIndex, false);
  return { first, last: resolveSelectedScrollLine(rows, rowIndex, true) };
}

describe("variable-height list rows", () => {
  test("counts a capped number of extra lines toward the list height", () => {
    const rows = buildListRows(makeListState([
      makeItem("plain", "Commands"),
      makeItem("snippet", "Documents", 1),
      makeItem("overflowing", "Documents", 5),
    ]));

    // Two headings and one spacer, a plain row, a two-line row, a capped
    // three-line row.
    expect(getListRowsHeight(rows)).toBe(3 + 1 + 2 + 3);
  });

  test("keeps the whole selected row inside a short viewport in both directions", () => {
    const results = [
      makeItem("a", "Documents", 2),
      makeItem("b", "Documents", 2),
      makeItem("c", "Documents", 2),
      makeItem("d", "Documents", 2),
    ];
    const rows = buildListRows(makeListState(results));
    const viewportHeight = 6;
    const itemRowIndexes = rows.flatMap((row, index) => (row.kind === "item" ? [index] : []));

    let scrollTop = 0;
    for (const rowIndex of itemRowIndexes) {
      const { first, last } = rowLineRange(rows, rowIndex);
      scrollTop = applyScroll(scrollTop, last, viewportHeight);
      expect(first).toBeGreaterThanOrEqual(scrollTop);
      expect(last).toBeLessThan(scrollTop + viewportHeight);
    }

    for (const rowIndex of [...itemRowIndexes].reverse()) {
      const { first, last } = rowLineRange(rows, rowIndex);
      scrollTop = applyScroll(scrollTop, first, viewportHeight);
      expect(first).toBeGreaterThanOrEqual(scrollTop);
      expect(last).toBeLessThan(scrollTop + viewportHeight);
    }
  });

  test("resolves no scroll target when the selection is not on a rendered row", () => {
    const rows = buildListRows(makeListState([makeItem("only", "Documents", 1)]));
    expect(resolveSelectedScrollLine(rows, -1, false)).toBe(-1);
    expect(resolveSelectedScrollLine(rows, rows.length, true)).toBe(-1);
  });
});
