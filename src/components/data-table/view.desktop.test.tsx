/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, createRef, useState, type RefObject } from "react";
import { tableHeaderPx } from "../../renderers/dom/data-table/dom";
import { WebDataTable } from "../../renderers/dom/data-table";
import { WebInputHostProvider } from "../../renderers/dom/input-host";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { WEB_CELL_HEIGHT } from "../../theme/font-scale";
import { createDefaultConfig } from "../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../ui";
import type { ScrollBoxRenderable } from "../../ui/host";
import type { DataTableCell, DataTableColumn, DataTableVisibleRange } from "../ui";
import { DataTableView } from "./view";

const { window: testWindow, render } = createDomTestHarness();

type StatementLine = { id: string; kind: "period-end" | "heading" | "line"; title: string };
/** A statement: a Period end row and a heading the cursor passes over, around lines it stops on. */
const statementLines: StatementLine[] = [
  { id: "period-end", kind: "period-end", title: "Period end" },
  ...Array.from({ length: 30 }, (_, index) => ({ id: `income-${index}`, kind: "line" as const, title: `Income ${index}` })),
  { id: "balance", kind: "heading", title: "Balance sheet" },
  ...Array.from({ length: 30 }, (_, index) => ({ id: `balance-${index}`, kind: "line" as const, title: `Balance ${index}` })),
];
const BALANCE_HEADING = 31;
const VIEWPORT_ROWS = 10;
const columns: DataTableColumn[] = [{ id: "title", label: "Title", width: 20, align: "left" }];

async function renderTable(items: StatementLine[], navigable: boolean) {
  const scrollRef = createRef<ScrollBoxRenderable>();
  const ranges: DataTableVisibleRange[] = [];
  const state = createInitialState(createDefaultConfig("/tmp/gloom-dom-table-leading-rows"));
  function Harness({ scrollRef }: { scrollRef: RefObject<ScrollBoxRenderable | null> }) {
    const ui = useUiHost();
    const renderer = useRendererHost();
    const [selectedIndex, setSelectedIndex] = useState(navigable ? 1 : 0);
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
      <WebInputHostProvider><AppContext value={createStaticAppStore(state)}>
        <DataTableView<StatementLine>
          focused
          isNavigable={navigable ? (line) => line.kind === "line" : undefined}
          selection={{ kind: "index", selectedIndex, onChange: (index) => setSelectedIndex(index) }}
          scrollRef={scrollRef}
          onVisibleRangeChange={(range) => ranges.push(range)}
          columns={columns}
          items={items}
          sortColumnId={null}
          sortDirection="asc"
          getItemKey={(line) => line.id}
          renderSectionHeader={(line) => line.kind === "heading" ? { text: line.title } : null}
          renderCell={(line): DataTableCell => ({ text: line.kind === "heading" ? "" : line.title })}
          emptyStateTitle="No rows"
          virtualize={false}
        />
      </AppContext></WebInputHostProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness scrollRef={scrollRef} />);
  const body = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  // happy-dom has no layout: a header row and ten body rows.
  Object.defineProperty(body, "clientHeight", { configurable: true, value: tableHeaderPx() + WEB_CELL_HEIGHT * VIEWPORT_ROWS });
  const press = async (key: string, count = 1) => {
    for (let step = 0; step < count; step += 1) {
      const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { testWindow.document.body.dispatchEvent(event); await Promise.resolve(); });
    }
    // The visible range is measured a frame after the scroll.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  };
  const topRow = () => body.scrollTop / WEB_CELL_HEIGHT;
  return { body, ranges, press, topRow };
}

// FA's Period end row: back up a statement by key, the cursor stopped on the first figure and Period end stayed hidden above it.
test("on the desktop the rows the cursor passes over above its first row come back into view as it returns there", async () => {
  const { ranges, press, topRow } = await renderTable(statementLines, true);
  const returns: Array<[string, string, number]> = [["up", "ArrowUp", 40], ["home", "Home", 1], ["page up", "PageUp", 10]];
  for (const [label, key, count] of returns) {
    await press("ArrowDown", 40);
    expect(topRow(), label).toBeGreaterThan(0);
    await press(key, count);
    expect(topRow(), label).toBe(0);
    expect(ranges.at(-1)?.start, label).toBe(0);
  }

  // A section's first line brings its heading along, which then heads the view.
  await press("End");
  await press("ArrowUp", 29);
  expect(topRow()).toBe(BALANCE_HEADING);
});

test("on the desktop a table the cursor stops on every row of scrolls one row at a time, as it always has", async () => {
  const { press, topRow } = await renderTable(statementLines.filter((line) => line.kind === "line"), false);
  await press("ArrowDown", 40);
  expect(topRow()).toBe(40 - VIEWPORT_ROWS + 1);
  await press("ArrowUp", VIEWPORT_ROWS - 1);
  expect(topRow()).toBe(40 - VIEWPORT_ROWS + 1);
  await press("ArrowUp");
  expect(topRow()).toBe(40 - VIEWPORT_ROWS);
  await press("Home");
  expect(topRow()).toBe(0);
});
