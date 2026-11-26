/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { DataTableView, type DataTableViewProps } from "../../../components/data-table/view";
import { TableColumnFitContext } from "../../../components/ui/data-table/column-fit";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui";
import { WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { WebInputHostProvider } from "../input-host";
import { createDomTestHarness } from "../test-utils";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness();

// happy-dom has no layout engine: every element measures as a body this many cells wide.
let viewportCells = 40;
const prototype = testWindow.HTMLElement.prototype;
const ownClientWidth = Object.getOwnPropertyDescriptor(prototype, "clientWidth");
beforeAll(() => {
  Object.defineProperty(prototype, "clientWidth", { configurable: true, get: () => viewportCells * WEB_CELL_WIDTH });
});
afterAll(() => {
  if (ownClientWidth) Object.defineProperty(prototype, "clientWidth", ownClientWidth);
  else delete (prototype as { clientWidth?: number }).clientWidth;
});

// 64 cells with the table's inset and gaps: TICKER, then five figures of ten cells. Forty cells hold three of them.
const COLUMNS = [
  { id: "symbol", label: "TICKER", width: 6 },
  ...["LAST", "CHG", "VOL", "CAP", "ASOF"].map((label) => ({ id: label.toLowerCase(), label, width: 10, align: "right" as const })),
];
const ROWS = ["NVDA", "AMD"];
type Row = (typeof ROWS)[number];

let setSort: (columnId: string | null) => void = () => {};
let savedCsv: string | null = null;

async function mount(props: Partial<DataTableViewProps<Row>> = {}, { everyColumn = false }: { everyColumn?: boolean } = {}) {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-dom-column-fit"));
  function Harness() {
    const ui = useUiHost();
    const renderer = useRendererHost();
    const [sortColumnId, updateSort] = useState<string | null>(null);
    setSort = updateSort;
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }}
      renderer={{ ...renderer, saveTextFile: async ({ name, text }) => { savedCsv = text; return name; } }}>
      <WebInputHostProvider><AppContext value={createStaticAppStore(state)}><PaneInstanceProvider paneId="column-fit-test">
        <TableColumnFitContext.Provider value={!everyColumn}>
          <DataTableView<Row> focused items={ROWS} columns={COLUMNS} getItemKey={(row) => row}
            renderCell={(row, column) => ({ text: column.id === "symbol" ? row : `${column.id} ${row}` })}
            selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
            sortColumnId={sortColumnId} sortDirection="desc" onHeaderClick={() => {}}
            emptyStateTitle="No rows" virtualize={false} {...props} />
        </TableColumnFitContext.Provider>
      </PaneInstanceProvider></AppContext></WebInputHostProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness />);
  const body = () => container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  return {
    container,
    body,
    headers: () => [...container.querySelectorAll('[data-gloom-role="data-table-header-cell"]')].map((cell) => cell.textContent?.trim()).join(" "),
    hidden: () => container.querySelector('[data-gloom-role="data-table-hidden-columns"] span')?.textContent ?? null,
    more: () => container.querySelector('button[aria-label="Show all columns"]') as HTMLElement | null,
    scrolls: () => body().style.overflowX === "auto",
    press: async (key: string) => {
      const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: true });
      await act(async () => { body().dispatchEvent(event as unknown as Event); });
    },
  };
}

test("a desktop table too narrow for its columns draws whole ones, names the rest and brings them back when asked", async () => {
  viewportCells = 40;
  const table = await mount();
  // The trailing columns left whole: nothing is drawn past the edge, so nothing scrolls sideways.
  expect(table.headers()).toBe("TICKER LAST CHG");
  expect(table.hidden()).toBe("3 hidden · VOL, CAP, ASOF");
  expect(table.scrolls()).toBe(false);

  // The press on More draws every column, in a table that scrolls to them.
  await act(async () => { table.more()!.click(); });
  expect(table.headers()).toBe("TICKER LAST CHG VOL CAP ASOF");
  expect(table.hidden()).toBeNull();
  expect(table.scrolls()).toBe(true);

  // Shift+Left at the start of all its columns fits them again, and Shift+Right is the same asking as More.
  await table.press("ArrowLeft");
  expect(table.headers()).toBe("TICKER LAST CHG");
  await table.press("ArrowRight");
  expect(table.headers()).toBe("TICKER LAST CHG VOL CAP ASOF");
});

test("a pane's own order leaves first, and the sorted column stays whatever the order says", async () => {
  viewportCells = 40;
  const table = await mount({ columnDropOrder: ["chg", "last"] });
  expect(table.headers()).toBe("TICKER VOL CAP");
  expect(table.hidden()).toBe("3 hidden · LAST, CHG, ASOF");
  // Rows in an order no column shows would read as unsorted.
  await act(async () => { setSort("chg"); });
  expect(table.headers()).toContain("CHG");
  expect(table.headers()).not.toContain("LAST");
});

test("a wider pane takes its columns back, and a fitted table exports every column", async () => {
  viewportCells = 40;
  const table = await mount();
  expect(table.hidden()).toBe("3 hidden · VOL, CAP, ASOF");
  // The pane's Export CSV reads its columns, not the ones the width left on screen.
  savedCsv = null;
  await exportPaneTable("column-fit-test", "table.csv");
  expect(savedCsv!.replace(/^\uFEFF/, "").split("\n").slice(0, 2)).toEqual(["TICKER,LAST,CHG,VOL,CAP,ASOF", "NVDA,last NVDA,chg NVDA,vol NVDA,cap NVDA,asof NVDA"]);
  viewportCells = 70;
  const wide = await mount();
  expect(wide.headers()).toBe("TICKER LAST CHG VOL CAP ASOF");
  expect(wide.hidden()).toBeNull();
  expect(wide.more()).toBeNull();
});

test("a table set not to scroll sideways keeps its columns, which the desktop narrows to the pane", async () => {
  viewportCells = 40;
  // TRIAL's list gave up its ticker to a fit by set widths, though all six columns had fitted narrowed.
  const table = await mount({ showHorizontalScrollbar: false });
  expect(table.headers()).toBe("TICKER LAST CHG VOL CAP ASOF");
  expect(table.hidden()).toBeNull();
  expect(table.more()).toBeNull();
});

test("a report draws every column whatever the width, for fn's rows to read", async () => {
  viewportCells = 40;
  const table = await mount({}, { everyColumn: true });
  expect(table.headers()).toBe("TICKER LAST CHG VOL CAP ASOF");
  expect(table.hidden()).toBeNull();
});
