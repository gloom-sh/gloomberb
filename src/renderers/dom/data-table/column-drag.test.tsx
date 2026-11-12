/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useRef } from "react";
import type { ScrollBoxRenderable } from "../../../ui/host";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { createDomTestHarness } from "../test-utils";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness();
const COLUMNS = ["Ticker", "Last", "Chg", "Vol"].map((label) => ({ id: label.toLowerCase(), label, width: 8 }));

async function renderTable() {
  const moves: [string, number][] = [];
  const sorts: string[] = [];
  const state = createInitialState(createDefaultConfig(":memory:"));
  function Harness() {
    const headerScrollRef = useRef<ScrollBoxRenderable | null>(null);
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <AppContext value={createStaticAppStore(state)}>
        <WebDataTable
          items={["AAPL", "MSFT"]}
          columns={COLUMNS}
          sortColumnId={null}
          sortDirection="asc"
          onHeaderClick={(columnId) => sorts.push(columnId)}
          onColumnMove={(columnId, toIndex) => moves.push([columnId, toIndex])}
          anchoredColumns={1}
          headerScrollRef={headerScrollRef}
          scrollRef={scrollRef}
          syncHeaderScroll={() => {}}
          onBodyScrollActivity={() => {}}
          getItemKey={String}
          isSelected={() => false}
          onSelect={() => {}}
          renderCell={(item) => ({ text: item })}
          emptyStateTitle="No quotes"
          virtualize={false}
        />
      </AppContext>
    );
  }
  const container = await render(<Harness />);
  // happy-dom lays nothing out: each header is 100px apart, 90px wide.
  const cells = [...container.querySelectorAll<HTMLElement>('[data-gloom-role="data-table-header-cell"]')];
  cells.forEach((cell, index) => {
    cell.getBoundingClientRect = () => ({ left: index * 100, right: index * 100 + 90, top: 0, bottom: 20, width: 90, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
  });
  const mouse = async (target: EventTarget, type: string, clientX: number) => {
    await act(async () => {
      target.dispatchEvent(new testWindow.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX }) as unknown as Event);
    });
  };
  const press = (label: string, clientX: number) => mouse(cells[COLUMNS.findIndex((column) => column.label === label)]!, "mousedown", clientX);
  const move = (clientX: number) => mouse(testWindow.document, "mousemove", clientX);
  const release = (clientX: number) => mouse(testWindow.document, "mouseup", clientX);
  const indicator = () => container.querySelector<HTMLElement>('[data-gloom-role="data-table-drop-indicator"]');
  return { cells, moves, sorts, press, move, release, indicator };
}

test("a header dragged past the threshold shows where it drops and moves its column there on release", async () => {
  const table = await renderTable();
  await table.press("Vol", 340);
  await table.move(337);
  expect(table.indicator()).toBeNull();

  await table.move(120);
  expect(table.indicator()?.style.left).toBe("95px");
  expect(table.cells[3]!.dataset.gloomDragging).toBe("true");

  await table.release(120);
  expect(table.moves).toEqual([["vol", 1]]);
  expect(table.sorts).toEqual([]);
  expect(table.indicator()).toBeNull();
  expect(table.cells[3]!.dataset.gloomDragging).toBeUndefined();
});

test("a click or a short wobble sorts; Escape puts a dragged column back", async () => {
  const table = await renderTable();
  await table.press("Chg", 240);
  await table.release(240);
  await table.press("Last", 140);
  await table.move(143);
  await table.release(143);
  expect(table.sorts).toEqual(["chg", "last"]);

  await table.press("Last", 140);
  await table.move(360);
  expect(table.indicator()?.style.left).toBe("395px");
  await act(async () => {
    testWindow.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  });
  expect(table.indicator()).toBeNull();
  await table.release(360);
  expect(table.moves).toEqual([]);
  expect(table.sorts).toEqual(["chg", "last"]);
});

test("the anchored first column neither drags nor takes a drop before it", async () => {
  const table = await renderTable();
  await table.press("Ticker", 40);
  expect(table.sorts).toEqual(["ticker"]);
  await table.press("Chg", 240);
  await table.move(5);
  expect(table.indicator()?.style.left).toBe("95px");
  await table.release(5);
  expect(table.moves).toEqual([["chg", 1]]);
});
