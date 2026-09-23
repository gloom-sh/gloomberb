import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender, emitKeypress, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { Input } from "../../ui";
import { Tabs } from "../ui/tabs";
import { DataTableView } from "./view";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let update: (options: Partial<Options>) => void;
interface Options { focused: boolean; keyboardNavigation: boolean; scroll: boolean; compact: boolean; editing: boolean; manyRows: boolean; tabs: boolean }
const rows = [{ id: "ALPH", value: "$100M", weight: "66.7%" }];
let selectedTab = "a";
let withTabs = false;

function Harness() {
  const [options, setOptions] = useState<Options>({ focused: true, keyboardNavigation: true, scroll: true, compact: false, editing: false, manyRows: false, tabs: withTabs });
  update = (next) => setOptions((current) => ({ ...current, ...next }));
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-horizontal"));
  return <AppContext value={{ state, dispatch: () => {} }}>
    <PaneInstanceProvider paneId="horizontal-table">
      <DataTableView
        focused={options.focused}
        keyboardNavigation={options.keyboardNavigation}
        showHorizontalScrollbar={options.scroll}
        rootBefore={options.editing
          ? <Input focused value="alpha beta gamma" />
          : options.tabs
            ? <Tabs focused tabs={[{ label: "A", value: "a" }, { label: "B", value: "b" }]} activeValue={selectedTab} onSelect={(value) => { selectedTab = value; }} />
            : undefined}
        selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
        columns={options.compact ? [{ id: "id", label: "TICKER", width: 8 }] : [
          { id: "id", label: "TICKER", width: 30 },
          { id: "value", label: "VALUE", width: 16 },
          { id: "weight", label: "WEIGHT", width: 12 },
        ]}
        items={options.manyRows ? Array.from({ length: 50 }, (_, index) => ({ ...rows[0]!, id: `ALPH${index}` })) : rows}
        sortColumnId={null}
        sortDirection="asc"
        onHeaderClick={() => {}}
        getItemKey={(row) => row.id}
        renderCell={(row, column) => ({ text: row[column.id as keyof typeof row] })}
        emptyStateTitle="No rows"
        headerScrollId="horizontal-header"
        bodyScrollId="horizontal-body"
      />
    </PaneInstanceProvider>
  </AppContext>;
}

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = undefined;
  selectedTab = "a";
  withTabs = false;
});

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await setup!.renderOnce(); });
}
function table(id: "header" | "body") {
  return setup!.renderer.root.findDescendantById(`horizontal-${id}`) as ScrollBoxRenderable;
}
async function key(event: TestKeyEvent) {
  const delivered = await emitKeypress(setup!, event, { trackPropagation: true });
  await settle();
  return delivered;
}

test("horizontal keys, body wheel, header wheel and scrollbar drag keep labels with values", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 40, height: 8 }); });
  await settle();
  const body = table("body");
  const header = table("header");
  expect(body.horizontalScrollBar.visible).toBe(true);
  expect((await key({ name: "right", ctrl: true })).defaultPrevented).toBe(true);
  expect(body.scrollLeft).toBe(20);
  expect(header.scrollLeft).toBe(body.scrollLeft);
  expect(setup!.captureCharFrame()).toContain("$100M");

  await act(async () => { await setup!.mockMouse.scroll(body.x + 2, body.y, "left"); });
  await settle();
  expect(body.scrollLeft).toBeLessThan(20);
  expect(header.scrollLeft).toBe(body.scrollLeft);
  const beforeHeaderWheel = body.scrollLeft;
  await act(async () => { await setup!.mockMouse.scroll(header.x + 2, header.y, "left"); });
  await settle();
  expect(body.scrollLeft).toBeLessThan(beforeHeaderWheel);
  expect(header.scrollLeft).toBe(body.scrollLeft);

  const bar = body.horizontalScrollBar;
  await act(async () => { await setup!.mockMouse.drag(bar.x + 18, bar.y, bar.x, bar.y); });
  await settle();
  expect(body.scrollLeft).toBe(0);
  expect(header.scrollLeft).toBe(0);
  expect(setup!.captureCharFrame()).toContain("ALPH");
});

test("horizontal shortcuts preserve editing, other modifiers, disabled focus and fitting tables", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 40, height: 8 }); });
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
  expect(setup!.renderer.currentFocusedEditor).not.toBeNull();
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
  withTabs = true;
  await act(async () => { setup = await testRender(<Harness />, { width: 40, height: 8 }); });
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
  await act(async () => { setup = await testRender(<Harness />, { width: 40, height: 8 }); });
  await act(async () => update({ manyRows: true }));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(true);
  for (let i = 0; i < 4; i++) await key({ name: "right", ctrl: true });
  expect(table("body").scrollLeft).toBe(table("body").scrollWidth - table("body").viewport.width);
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  expect(table("header").viewport.width).toBe(table("body").viewport.width);
  await act(async () => setup!.resize(40, 64));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(false);
  expect(table("header").viewport.width).toBe(table("body").viewport.width);
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  await act(async () => setup!.resize(40, 8));
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
