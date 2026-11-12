import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { Input, Text } from "../../ui";
import { Tabs } from "../ui/tabs";
import { DataTableView } from "./view";

/** The identifier column is wide enough that one scroll step hides it. */
const WIDE_ID_COLUMNS = [
  { id: "id", label: "TICKER", width: 30 },
  { id: "value", label: "VALUE", width: 16 },
  { id: "weight", label: "WEIGHT", width: 12 },
];
/** A narrow identifier column ahead of wide values, the shape a frozen first column pins. */
const NARROW_ID_COLUMNS = [
  { id: "id", label: "TICKER", width: 6 },
  { id: "value", label: "VALUE", width: 30 },
  { id: "weight", label: "WEIGHT", width: 30 },
];

const tui = createOpenTuiTestHarness();
let update: (options: Partial<Options>) => void;
interface Options {
  focused: boolean;
  keyboardNavigation: boolean;
  scroll: boolean;
  compact: boolean;
  editing: boolean;
  manyRows: boolean;
  frozen: boolean | undefined;
  tabs: boolean;
  /** The first column drawn by the pane (`content`), not as text. */
  drawnFirst: boolean;
  columns: typeof WIDE_ID_COLUMNS;
  /** The column the table opens centred on. */
  reveal: string | undefined;
}
const DEFAULT_OPTIONS: Options = {
  focused: true,
  keyboardNavigation: true,
  scroll: true,
  compact: false,
  editing: false,
  manyRows: false,
  frozen: false,
  tabs: false,
  drawnFirst: false,
  columns: WIDE_ID_COLUMNS,
  reveal: undefined,
};
const rows = [{ id: "ALPH", value: "$100M", weight: "66.7%" }];
let selectedTab = "a";

function Harness({ initial }: { initial: Partial<Options> }) {
  const [options, setOptions] = useState<Options>({ ...DEFAULT_OPTIONS, ...initial });
  update = (next) => setOptions((current) => ({ ...current, ...next }));
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-horizontal"));
  return <AppContext value={createStaticAppStore(state)}>
    <PaneInstanceProvider paneId="horizontal-table">
      <DataTableView
        focused={options.focused}
        keyboardNavigation={options.keyboardNavigation}
        showHorizontalScrollbar={options.scroll}
        freezeFirstColumn={options.frozen}
        revealColumnId={options.reveal}
        rootBefore={options.editing
          ? <Input focused value="alpha beta gamma" />
          : options.tabs
            ? <Tabs focused tabs={[{ label: "A", value: "a" }, { label: "B", value: "b" }]} activeValue={selectedTab} onSelect={(value) => { selectedTab = value; }} />
            : undefined}
        selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
        columns={options.compact ? [{ id: "id", label: "TICKER", width: 8 }] : options.columns}
        items={options.manyRows ? Array.from({ length: 50 }, (_, index) => ({ ...rows[0]!, id: `ALPH${index}` })) : rows}
        sortColumnId={null}
        sortDirection="asc"
        onHeaderClick={() => {}}
        getItemKey={(row) => row.id}
        // Each value fills its column exactly, as a wide table's figures do: none has blank to give up or is cut.
        renderCell={(row, column) => ({
          text: (row[column.id as keyof typeof row] ?? "20.0%").padEnd(column.width).slice(0, column.width),
          ...(options.drawnFirst && column.id === "id" ? { content: <Text>{row.id}</Text> } : {}),
        })}
        emptyStateTitle="No rows"
        headerScrollId="horizontal-header"
        bodyScrollId="horizontal-body"
      />
    </PaneInstanceProvider>
  </AppContext>;
}

afterEach(() => {
  selectedTab = "a";
});

async function mount(initial: Partial<Options> = {}) {
  await act(async () => { await tui.render(<Harness initial={initial} />, { width: 40, height: 8 }); });
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await tui.setup().renderOnce(); });
}
function table(id: "header" | "body") {
  return tui.setup().renderer.root.findDescendantById(`horizontal-${id}`) as ScrollBoxRenderable;
}
async function key(event: TestKeyEvent) {
  const delivered = await tui.emitKeypress(event, { trackPropagation: true });
  await settle();
  return delivered;
}

test("horizontal keys, body wheel, header wheel and scrollbar drag keep labels with values", async () => {
  await mount();
  await settle();
  const body = table("body");
  const header = table("header");
  expect(body.horizontalScrollBar.visible).toBe(true);
  expect((await key({ name: "right", ctrl: true })).defaultPrevented).toBe(true);
  expect(body.scrollLeft).toBe(20);
  expect(header.scrollLeft).toBe(body.scrollLeft);
  expect(tui.frame()).toContain("$100M");

  await act(async () => { await tui.setup().mockMouse.scroll(body.x + 2, body.y, "left"); });
  await settle();
  expect(body.scrollLeft).toBeLessThan(20);
  expect(header.scrollLeft).toBe(body.scrollLeft);
  const beforeHeaderWheel = body.scrollLeft;
  await act(async () => { await tui.setup().mockMouse.scroll(header.x + 2, header.y, "left"); });
  await settle();
  expect(body.scrollLeft).toBeLessThan(beforeHeaderWheel);
  expect(header.scrollLeft).toBe(body.scrollLeft);

  const bar = body.horizontalScrollBar;
  await act(async () => { await tui.setup().mockMouse.drag(bar.x + 18, bar.y, bar.x, bar.y); });
  await settle();
  expect(body.scrollLeft).toBe(0);
  expect(header.scrollLeft).toBe(0);
  expect(tui.frame()).toContain("ALPH");
});

test("horizontal shortcuts preserve editing, other modifiers, disabled focus and fitting tables", async () => {
  await mount();
  await settle();
  for (const event of [
    { name: "right" },
    { name: "right", ctrl: true, shift: true },
    { name: "right", ctrl: true, alt: true },
    { name: "right", ctrl: true, option: true },
    { name: "right", ctrl: true, meta: true },
    { name: "right", ctrl: true, super: true },
  ]) {
    expect((await key(event)).defaultPrevented).toBe(false);
    expect(table("body").scrollLeft).toBe(0);
  }
  await act(async () => update({ editing: true }));
  await settle();
  expect(tui.setup().renderer.currentFocusedEditor).not.toBeNull();
  await key({ name: "right", ctrl: true });
  expect(table("body").scrollLeft).toBe(0);
  await act(async () => update({ editing: false }));
  await settle();
  for (const options of [
    { focused: false },
    { focused: true, keyboardNavigation: false },
    { keyboardNavigation: true, scroll: false },
    { scroll: true, compact: true },
  ]) {
    await act(async () => update(options));
    await settle();
    expect((await key({ name: "right", ctrl: true })).defaultPrevented).toBe(false);
    expect(table("body").scrollLeft).toBe(0);
  }
  expect(table("body").horizontalScrollBar.visible).toBe(false);
});

test("Shift+arrows scroll a wide table ahead of a focused tab strip, which keeps plain arrows", async () => {
  // Mounted with the table, the strip's key handler registers first.
  await mount({ tabs: true });
  await settle();
  // macOS keeps Ctrl+arrows for Spaces, so Shift+arrows are the columns key everywhere.
  expect((await key({ name: "right", shift: true })).defaultPrevented).toBe(true);
  expect(table("body").scrollLeft).toBe(20);
  expect(table("header").scrollLeft).toBe(20);
  // At the edge the key still belongs to the table instead of switching tabs.
  for (let i = 0; i < 4; i++) await key({ name: "right", shift: true });
  expect(selectedTab).toBe("a");
  await key({ name: "left", shift: true });
  expect(table("body").scrollLeft).toBeLessThan(table("body").scrollWidth - table("body").viewport.width);
  await key({ name: "right" });
  expect(selectedTab).toBe("b");
});

test("the last columns stay aligned when vertical overflow changes the body viewport", async () => {
  await mount();
  await act(async () => update({ manyRows: true }));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(true);
  for (let i = 0; i < 4; i++) await key({ name: "right", ctrl: true });
  expect(table("body").scrollLeft).toBe(table("body").scrollWidth - table("body").viewport.width);
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  expect(table("header").viewport.width).toBe(table("body").viewport.width);
  await act(async () => tui.setup().resize(40, 64));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(false);
  expect(table("header").viewport.width).toBe(table("body").viewport.width);
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  await act(async () => tui.setup().resize(40, 8));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(true);
  expect(table("header").viewport.width).toBe(table("body").viewport.width);
  await act(async () => update({ manyRows: false }));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(false);
  expect(table("header").viewport.width).toBe(table("body").viewport.width);
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  await act(async () => update({ compact: true }));
  await settle();
  expect(table("body").scrollLeft).toBe(0);
  expect(table("header").scrollLeft).toBe(0);
});

test("frozen identifiers survive keyboard, wheel, scrollbar and vertical resize without corrupting partial text", async () => {
  await mount({ frozen: true, columns: NARROW_ID_COLUMNS });
  await settle();
  for (let i = 0; i < 4; i++) await key({ name: "right", ctrl: true });
  expect(tui.frame()).toContain("ALPH");
  expect(tui.frame()).toContain("66.7%");
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  await act(async () => { await tui.setup().mockMouse.click(2, 1); });
  await settle();
  expect(tui.frame()).toContain("ALPH");
  await act(async () => { await tui.setup().mockMouse.scroll(10, 1, "left"); });
  await settle();
  expect(tui.frame()).toContain("ALPH");
  const before = table("body").scrollLeft;
  await act(async () => { await tui.setup().mockMouse.scroll(10, 0, "left"); });
  await settle();
  expect(table("body").scrollLeft).toBeLessThan(before);
  expect(tui.frame()).toContain("ALPH");
  const bar = table("body").horizontalScrollBar;
  await act(async () => { await tui.setup().mockMouse.drag(bar.x + 18, bar.y, bar.x, bar.y); });
  await settle();
  expect(table("body").scrollLeft).toBe(0);
  expect(tui.frame()).toContain("ALPH");
  await act(async () => update({ manyRows: true }));
  await settle();
  for (let i = 0; i < 4; i++) await key({ name: "right", ctrl: true });
  expect(tui.frame()).toContain("ALPH0");
  expect(table("body").verticalScrollBar.visible).toBe(true);
  await act(async () => tui.setup().resize(40, 64));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(false);
  expect(tui.frame()).toContain("ALPH0");
  await act(async () => update({ compact: true }));
  await settle();
  expect(table("body").scrollLeft).toBe(0);
  expect(table("header").scrollLeft).toBe(0);
  expect(tui.frame()).toContain("ALPH0");
});

/** A tenor column and nine moneyness columns from 80% to 120%, as OVDV's grid. */
const moneynessColumns = (width: number) => [{ id: "id", label: "TENOR", width: 6 },
  ...Array.from({ length: 9 }, (_, index) => ({ id: `m${index}`, label: `${80 + 5 * index}%`, width }))];

test("a table opens centred on the column asked for, and a refresh that resizes columns keeps the reader's scroll", async () => {
  await mount({ frozen: true, columns: moneynessColumns(7), reveal: "m4" });
  await settle();
  const opened = table("body").scrollLeft;
  expect(opened).toBeGreaterThan(0);
  expect(tui.frame()).toContain("100%");
  expect(tui.frame()).not.toContain("80%");
  expect(table("header").scrollLeft).toBe(opened);
  // Shift+Right moves on from there; a refresh whose figures widen the columns leaves it where the reader put it.
  await key({ name: "right", shift: true });
  const scrolled = table("body").scrollLeft;
  expect(scrolled).toBeGreaterThan(opened);
  await act(async () => update({ columns: moneynessColumns(8) }));
  await settle();
  expect(table("body").scrollLeft).toBe(scrolled);
  // Another column asked for is centred again.
  await act(async () => update({ reveal: "m1" }));
  await settle();
  expect(table("body").scrollLeft).toBeLessThan(scrolled);
  expect(tui.frame()).toContain("85%");
});

test("a table that leaves freezing unset pins a narrow first column and lets a wide one scroll away", async () => {
  await mount({ frozen: undefined, columns: NARROW_ID_COLUMNS });
  await settle();
  for (let i = 0; i < 2; i++) await key({ name: "right", shift: true });
  expect(table("body").scrollLeft).toBeGreaterThan(0);
  expect(tui.frame()).toContain("ALPH");
  expect(tui.frame()).toContain("66.7%");
  // Wide, it scrolls: a step is half the viewport, where a frozen one would stop at the value column's edge (17).
  await act(async () => update({ columns: WIDE_ID_COLUMNS }));
  await settle();
  await key({ name: "left", shift: true });
  await key({ name: "left", shift: true });
  await key({ name: "right", shift: true });
  expect(table("body").scrollLeft).toBe(20);
  // A narrow first column the pane draws itself pins as drawn, once, beside the values (a supply-chain name).
  await act(async () => update({ columns: NARROW_ID_COLUMNS, drawnFirst: true }));
  await settle();
  await key({ name: "left", shift: true });
  await key({ name: "left", shift: true });
  for (let i = 0; i < 2; i++) await key({ name: "right", shift: true });
  expect(table("body").scrollLeft).toBeGreaterThan(0);
  const row = tui.frame().split("\n").find((line) => line.includes("66.7%"))!;
  expect(row.match(/ALPH/g)).toHaveLength(1);
  expect(row.indexOf("ALPH")).toBeLessThan(row.indexOf("66.7%"));
  // A rank leading the row does not name it: pinned, it would hold "1" beside the values while the ticker scrolled away.
  await act(async () => update({ columns: [{ id: "id", label: "#", width: 3 }, ...NARROW_ID_COLUMNS.slice(1)], drawnFirst: false }));
  await settle();
  await key({ name: "left", shift: true });
  await key({ name: "left", shift: true });
  await key({ name: "right", shift: true });
  expect(table("body").scrollLeft).toBe(20);
  expect(tui.frame()).not.toContain("ALPH");
});

test("an ordinary table still scrolls its first column normally", async () => {
  await mount({ frozen: true, columns: NARROW_ID_COLUMNS });
  await act(async () => update({ frozen: false }));
  await settle();
  await key({ name: "right", ctrl: true });
  expect(table("body").scrollLeft).toBe(20);
  expect(tui.frame()).not.toContain("ALPH");
  expect(tui.frame()).toContain("66.7%");
  await act(async () => update({ frozen: true }));
  await settle();
  expect(tui.frame()).toContain("ALPH");
});
