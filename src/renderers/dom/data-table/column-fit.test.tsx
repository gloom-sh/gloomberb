/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { DataTableView, type DataTableViewProps } from "../../../components/data-table/view";
import { PaneFooterProvider } from "../../../components/layout/pane/footer/registration";
import { TableColumnFitContext } from "../../../components/ui/data-table/column-fit";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { getLanguage, setLanguage } from "../../../i18n";
import { registerTranslations } from "../../../public/i18n";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
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
  const registry = createRemoteUiRegistry();
  let menu: string[] = [];
  function Harness() {
    const ui = useUiHost();
    const renderer = useRendererHost();
    const [sortColumnId, updateSort] = useState<string | null>(null);
    setSort = updateSort;
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }}
      renderer={{ ...renderer, saveTextFile: async ({ name, text }) => { savedCsv = text; return name; } }}>
      <RemoteUiRegistryProvider registry={registry}><WebInputHostProvider><AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="column-fit-test"><PaneFooterProvider>{(footer) => {
          menu = footer.menu.map((item) => item.label ?? "");
          return <TableColumnFitContext.Provider value={!everyColumn}>
            <DataTableView<Row> focused items={ROWS} columns={COLUMNS} getItemKey={(row) => row}
              renderCell={(row, column) => ({ text: column.id === "symbol" ? row : `${column.id} ${row}` })}
              selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
              sortColumnId={sortColumnId} sortDirection="desc" onHeaderClick={() => {}}
              emptyStateTitle="No rows" virtualize={false} {...props} />
          </TableColumnFitContext.Provider>;
        }}</PaneFooterProvider></PaneInstanceProvider>
      </AppContext></WebInputHostProvider></RemoteUiRegistryProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness />);
  const body = () => container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  const part = (role: string) => container.querySelector(`[data-gloom-role="data-table-hidden-by-${role}"]`)?.textContent ?? null;
  const headerCells = () => [...container.querySelectorAll<HTMLElement>('[data-gloom-role="data-table-header-cell"]')];
  const mouse = async (target: EventTarget, type: string, clientX: number) => {
    await act(async () => {
      target.dispatchEvent(new testWindow.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX }) as unknown as Event);
    });
  };
  return {
    container,
    body,
    headers: () => headerCells().map((cell) => cell.textContent?.trim()).join(" "),
    /** What the table's fit left out, the words beside More. */
    hidden: () => part("fit"),
    /** What the pane left out itself. */
    paneHidden: () => part("pane"),
    more: (label = "Show all columns") => container.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null,
    menu: () => menu,
    scrolls: () => body().style.overflowX === "auto",
    press: async (key: string) => {
      const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: true });
      await act(async () => { body().dispatchEvent(event as unknown as Event); });
    },
    /** The table as automation reads it: the columns on screen, and each row's cells by column id. */
    semantic: () => {
      const node = registry.snapshot().find((entry) => entry.role === "table")!;
      const rows = registry.detail(node.id)!.metadata!.rows as { cells: { columnId: string; columnLabel: string }[] }[];
      return { columns: node.metadata!.columns as { id: string; label: string }[], cells: rows[0]!.cells };
    },
    /** Drags the header `label` to the pointer position `to`. happy-dom lays nothing out: each header is 100px apart, 90px wide. */
    drag: async (label: string, to: number) => {
      const cells = headerCells();
      cells.forEach((cell, index) => {
        cell.getBoundingClientRect = () => ({ left: index * 100, right: index * 100 + 90, top: 0, bottom: 20, width: 90, height: 20, x: index * 100, y: 0, toJSON: () => ({}) });
      });
      const from = cells.findIndex((cell) => cell.textContent?.trim() === label);
      await mouse(cells[from]!, "mousedown", from * 100 + 40);
      await mouse(testWindow.document, "mousemove", to);
      await mouse(testWindow.document, "mouseup", to);
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

test("a column set to grow narrows before any column leaves, and the step right draws it at its set width again", async () => {
  // 55 cells as set, in a body of 48: the name has the seven to give, so nothing leaves and nothing scrolls.
  viewportCells = 48;
  const table = await mount({ columns: [
    { id: "symbol", label: "TICKER", width: 6 },
    { id: "name", label: "NAME", width: 24, flexGrow: 1 },
    { id: "last", label: "LAST", width: 10, align: "right" },
    { id: "chg", label: "CHG", width: 10, align: "right" },
  ] });
  expect(table.headers()).toBe("TICKER NAME LAST CHG");
  expect(table.hidden()).toBeNull();
  expect(table.scrolls()).toBe(false);
  // A sentence in that column is read whole in the table that scrolls sideways, as it was before the fit.
  await table.press("ArrowRight");
  expect(table.scrolls()).toBe(true);
  await table.press("ArrowLeft");
  expect(table.scrolls()).toBe(false);
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

test("the fit measures the header as drawn: a longer translation leaves a column out, and the export keeps the pane's labels", async () => {
  const language = getLanguage();
  const remove = registerTranslations("column-fit-test", "es", { change: "variación del día", date: "fecha del dato" });
  try {
    // 44 cells as the pane wrote them, in a body of 44.
    viewportCells = 44;
    const table = await mount({ columns: [
      { id: "symbol", label: "TICKER", width: 6 },
      { id: "last", label: "LAST", width: 10, align: "right" },
      { id: "chg", label: "CHG", width: 10, align: "right", labelTranslation: { pluginId: "column-fit-test", key: "change" } },
      { id: "date", label: "As of", width: 10, align: "right", labelTranslation: { pluginId: "column-fit-test", key: "date" } },
    ] });
    expect(table.headers()).toBe("TICKER LAST CHG AS OF");
    expect(table.hidden()).toBeNull();

    // A header longer than its column widens it. Fitted by the labels the pane wrote, all four still "fit" and the
    // last one is drawn past the edge. The date stays the column kept longest though its header no longer says "As of".
    await act(async () => { setLanguage("es"); });
    expect(table.headers()).toBe("TICKER LAST FECHA DEL DATO");
    expect(table.hidden()).toBe("1 hidden · VARIACIÓN DEL DÍA");
    expect(table.scrolls()).toBe(false);

    // What reads the table rather than its picture keeps the pane's own labels, for every column.
    expect(table.semantic().columns).toEqual([{ id: "symbol", label: "TICKER" }, { id: "last", label: "LAST" }, { id: "date", label: "As of" }]);
    savedCsv = null;
    await exportPaneTable("column-fit-test", "table.csv");
    expect(savedCsv!.replace(/^\uFEFF/, "").split("\n")[0]).toBe("TICKER,LAST,CHG,As of");
  } finally {
    await act(async () => { remove(); setLanguage(language); });
  }
});

test("a narrowed column is still the pane's column: one cell a row for what reads the table, and a drag onto it lands on it", async () => {
  // EXTRA leaves and NAME, set to grow, gives up six cells: the column drawn is a narrower copy of the pane's.
  viewportCells = 50;
  const columns = [
    { id: "symbol", label: "TICKER", width: 6 },
    { id: "extra", label: "EXTRA", width: 10, align: "right" as const },
    { id: "name", label: "NAME", width: 24, flexGrow: 1 },
    { id: "last", label: "LAST", width: 10, align: "right" as const },
    { id: "chg", label: "CHG", width: 10, align: "right" as const },
  ];
  const moves: [string, number][] = [];
  const onColumnMove = (columnId: string, toIndex: number) => { moves.push([columnId, toIndex]); };
  const table = await mount({ columns, columnDropOrder: ["extra"], onColumnMove });
  expect(table.headers()).toBe("TICKER NAME LAST CHG");
  expect(table.hidden()).toBe("1 hidden · EXTRA");
  expect(table.scrolls()).toBe(false);

  // Each column once, the one left out after the ones on screen: a copy told apart by identity was read twice.
  expect(table.semantic().columns.map((column) => column.id)).toEqual(["symbol", "name", "last", "chg"]);
  expect(table.semantic().cells.map((cell) => cell.columnId)).toEqual(["symbol", "name", "last", "chg", "extra"]);

  // CHG dropped before NAME takes NAME's place among the pane's own columns, the hidden EXTRA counted.
  await table.drag("CHG", 120);
  expect(moves).toEqual([["chg", 2]]);

  // NAME anchored beside TICKER: narrowed, it is still one of the two that nothing drops before.
  moves.length = 0;
  const anchored = await mount({ columns: [columns[0]!, columns[2]!, columns[1]!, ...columns.slice(3)], columnDropOrder: ["extra"], onColumnMove, anchoredColumns: 2 });
  expect(anchored.headers()).toBe("TICKER NAME LAST CHG");
  await anchored.drag("CHG", 5);
  expect(moves).toEqual([["chg", 3]]);
});

test("the line says what More draws again apart from what the pane left out, which only a wider pane shows", async () => {
  // A book as PF draws it: the pane gives up its cost, month and time for its own width, and the table's fit, narrower
  // still, the average cost.
  const book = [
    { id: "symbol", label: "TICKER", width: 6 },
    ...["QTY", "AVG COST", "COST (USD)", "LAST", "VALUE", "P&L", "1M", "AS OF UTC"]
      .map((label) => ({ id: label.toLowerCase(), label, width: label.length > 8 ? 12 : 10, align: "right" as const })),
  ];
  const columns = dropColumnsToFit(book, 64, ["cost (usd)", "1m", "as of utc"]);
  viewportCells = 56;
  const table = await mount({ columns, columnDropOrder: ["avg cost"] });
  expect(table.headers()).toBe("TICKER QTY LAST VALUE P&L");
  expect(table.hidden()).toBe("1 hidden · AVG COST");
  expect(table.paneHidden()).toBe("3 need a wider pane · COST (USD), 1M, AS OF UTC");
  // More does not draw them all, and does not say it does.
  expect(table.more()).toBeNull();
  expect(table.menu()).toEqual(["Show More Columns"]);

  await act(async () => { table.more("Show hidden columns")!.click(); });
  expect(table.headers()).toBe("TICKER QTY AVG COST LAST VALUE P&L");
  expect(table.scrolls()).toBe(true);
  // Nothing is left for More to draw: the pane's own are named as they are in a table that fits, with no button.
  expect(table.hidden()).toBeNull();
  expect(table.paneHidden()).toBe("3 hidden · COST (USD), 1M, AS OF UTC");
  expect(table.container.querySelector('[data-gloom-role="data-table-hidden-columns"] button')).toBeNull();
});
