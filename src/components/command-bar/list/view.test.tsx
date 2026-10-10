import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { CommandBarListBody } from "./view";
import type { CommandBarListRow, ListScreenState, ResultItem } from "./model";

const tui = createOpenTuiTestHarness();

function item(overrides: Partial<ResultItem> & { id: string; label: string }): ResultItem {
  return {
    detail: "",
    category: "Commands",
    kind: "command",
    action: () => {},
    ...overrides,
  };
}

function rows(items: ResultItem[]): CommandBarListRow[] {
  return [
    { kind: "heading", id: "heading", label: "Commands" },
    ...items.map((entry, index) => ({ kind: "item" as const, item: entry, globalIdx: index })),
  ];
}

const LIST_STATE: ListScreenState = {
  kind: "root",
  title: "Commands",
  query: "port",
  selectedIdx: -1,
  hoveredIdx: null,
  results: [],
  searching: false,
  emptyLabel: "",
  emptyDetail: "",
  footerLeft: "",
  footerRight: "",
};

function ListHarness({ nativeListRows, labelWidth = 40 }: { nativeListRows: CommandBarListRow[]; labelWidth?: number }) {
  return (
    <CommandBarListBody
      visibleListState={LIST_STATE}
      nativeListRows={nativeListRows}
      listBodyHeight={16}
      contentPadding={3}
      labelWidth={labelWidth}
      nativePaneChrome={false}
      nativeListScrollRef={{ current: null }}
      paletteAccentText="#ffffff"
      paletteBg="#000000"
      paletteHeadingText="#ffffff"
      paletteHoverBg="#000000"
      paletteMatchText="#ffffff"
      paletteSelectedBg="#000000"
      paletteSelectedText="#ffffff"
      paletteSubtleText="#ffffff"
      paletteText="#ffffff"
      panelBg="#000000"
      queryDisplayWidth={50}
      trailingWidth={10}
      onHoverIndex={() => {}}
      onListScroll={() => {}}
      onRowMouseDown={() => {}}
    />
  );
}

function columnOf(frame: string, text: string): number {
  const line = frame.split("\n").find((row) => row.includes(text));
  return line ? line.indexOf(text) : -1;
}

/**
 * Instruments and documents arrive after the local rows and carry wider badges
 * than they do, so a column measured from what is on screen would widen
 * mid-query and drag every label already rendered to the right.
 */
test("keeps labels in place when a later section brings wider badges", async () => {
  const local = [
    item({ id: "portfolio", label: "Open Portfolio" }),
    item({ id: "quote", label: "Quote", right: "Q" }),
  ];

  await tui.render(<ListHarness nativeListRows={rows(local)} />, { width: 60, height: 20 });
  await tui.setup().renderOnce();
  const before = tui.frame();
  await tui.render(
    <ListHarness
      nativeListRows={rows([
        ...local,
        item({ id: "spy", label: "SPDR S&P 500", kind: "search", badge: "ETF" }),
        item({ id: "filing", label: "Annual report", kind: "action", badge: "10-K" }),
        item({ id: "derivative", label: "Call spread", kind: "search", badge: "DERIV" }),
      ])}
    />,
    { width: 60, height: 20 },
  );
  await tui.setup().renderOnce();
  const after = tui.frame();

  expect(columnOf(before, "Open Portfolio")).toBeGreaterThan(0);
  expect(columnOf(after, "Open Portfolio")).toBe(columnOf(before, "Open Portfolio"));
  expect(columnOf(after, "Commands")).toBe(columnOf(before, "Commands"));
  // The widest badge ends one gap short of the label edge it shares.
  expect(columnOf(after, "DERIV") + "DERIV".length).toBe(columnOf(after, "Call spread") - 1);
});

/**
 * SAP is SAP SE on four venues and Saputo on TSX; only the name tells the rows
 * apart. It gives way before the symbol and goes once it would be a stub.
 */
test("draws an instrument's name after its symbol and drops it before the symbol on a narrow row", async () => {
  const listings = [
    item({ id: "sap", label: "SAP", name: "SAP SE", kind: "search", badge: "EQ", right: "XETRA" }),
    item({ id: "saputo", label: "SAP", name: "Saputo Inc.", kind: "search", badge: "EQ", right: "TSX" }),
    item({ id: "brk", label: "BRK.B", name: "Berkshire Hathaway Inc. New", kind: "search", badge: "EQ", right: "NYSE" }),
  ];
  const render = async (labelWidth: number) => {
    await tui.render(<ListHarness nativeListRows={rows(listings)} labelWidth={labelWidth} />, { width: 60, height: 20 });
    await tui.setup().renderOnce();
    return tui.frame();
  };

  const wide = await render(40);
  expect(wide).toContain("SAP  Saputo Inc.");
  expect(wide).toContain("BRK.B  Berkshire Hathaway Inc... NYSE");
  expect(columnOf(wide, "TSX")).toBe(columnOf(wide, "XETRA"));

  const narrow = await render(18);
  expect(narrow).toContain("SAP");
  expect(narrow).toContain("BRK.B");
  expect(narrow).not.toContain("Saputo");
  expect(narrow).not.toContain("Berk");
});
