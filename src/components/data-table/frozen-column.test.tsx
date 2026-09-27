import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender, emitKeypress, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { Input } from "../../ui";
import { DataTableView } from "./view";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let update: (options: Partial<Options>) => void;
interface Options { focused: boolean; keyboardNavigation: boolean; scroll: boolean; compact: boolean; editing: boolean; manyRows: boolean; frozen: boolean }
const rows = [{ id: "ALPH", value: "$100M", weight: "66.7%" }];

function Harness() {
  const [options, setOptions] = useState<Options>({ focused: true, keyboardNavigation: true, scroll: true, compact: false, editing: false, manyRows: false, frozen: true });
  update = (next) => setOptions((current) => ({ ...current, ...next }));
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-horizontal"));
  return <AppContext value={createStaticAppStore(state)}>
    <PaneInstanceProvider paneId="horizontal-table">
      <DataTableView
        focused={options.focused}
        keyboardNavigation={options.keyboardNavigation}
        showHorizontalScrollbar={options.scroll}
        freezeFirstColumn={options.frozen}
        rootBefore={options.editing ? <Input focused value="alpha beta gamma" /> : undefined}
        selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
        columns={options.compact ? [{ id: "id", label: "TICKER", width: 8 }] : [
          { id: "id", label: "TICKER", width: 6 },
          { id: "value", label: "VALUE", width: 30 },
          { id: "weight", label: "WEIGHT", width: 30 },
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

test("frozen identifiers survive keyboard, wheel, scrollbar and vertical resize without corrupting partial text", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 40, height: 8 }); });
  await settle();
  for (let i = 0; i < 4; i++) await key({ name: "right", ctrl: true });
  expect(setup!.captureCharFrame()).toContain("ALPH");
  expect(setup!.captureCharFrame()).toContain("66.7%");
  expect(table("header").scrollLeft).toBe(table("body").scrollLeft);
  await act(async () => { await setup!.mockMouse.click(2, 1); });
  await settle();
  expect(setup!.captureCharFrame()).toContain("ALPH");
  await act(async () => { await setup!.mockMouse.scroll(10, 1, "left"); });
  await settle();
  expect(setup!.captureCharFrame()).toContain("ALPH");
  const before = table("body").scrollLeft;
  await act(async () => { await setup!.mockMouse.scroll(10, 0, "left"); });
  await settle();
  expect(table("body").scrollLeft).toBeLessThan(before);
  expect(setup!.captureCharFrame()).toContain("ALPH");
  const bar = table("body").horizontalScrollBar;
  await act(async () => { await setup!.mockMouse.drag(bar.x + 18, bar.y, bar.x, bar.y); });
  await settle();
  expect(table("body").scrollLeft).toBe(0);
  expect(setup!.captureCharFrame()).toContain("ALPH");
  await act(async () => update({ manyRows: true }));
  await settle();
  for (let i = 0; i < 4; i++) await key({ name: "right", ctrl: true });
  expect(setup!.captureCharFrame()).toContain("ALPH0");
  expect(table("body").verticalScrollBar.visible).toBe(true);
  await act(async () => setup!.resize(40, 64));
  await settle();
  expect(table("body").verticalScrollBar.visible).toBe(false);
  expect(setup!.captureCharFrame()).toContain("ALPH0");
  await act(async () => update({ compact: true }));
  await settle();
  expect(table("body").scrollLeft).toBe(0);
  expect(table("header").scrollLeft).toBe(0);
  expect(setup!.captureCharFrame()).toContain("ALPH0");
});

test("an ordinary table still scrolls its first column normally", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 40, height: 8 }); });
  await act(async () => update({ frozen: false }));
  await settle();
  await key({ name: "right", ctrl: true });
  expect(table("body").scrollLeft).toBe(20);
  expect(setup!.captureCharFrame()).not.toContain("ALPH");
  expect(setup!.captureCharFrame()).toContain("66.7%");
  await act(async () => update({ frozen: true }));
  await settle();
  expect(setup!.captureCharFrame()).toContain("ALPH");
});
