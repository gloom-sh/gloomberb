/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, createRef, useState } from "react";
import { DataTableView, type DataTableViewProps } from "../../../../components/data-table/view";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createStaticAppStore } from "../../../../test-support/app-store";
import { createDefaultConfig } from "../../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../../ui";
import type { ScrollBoxRenderable } from "../../../../ui/host";
import { WebInputHostProvider } from "../input-host";
import { WEB_CELL_WIDTH } from "../../../../theme/font-scale";
import { createDomTestHarness } from "../test-utils";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness();

interface LiveOptions { focused: boolean; frozen: boolean }
let setOptions: (patch: Partial<LiveOptions>) => void = () => {};

/** Mount DataTableView on the web DataTable; `setOptions` flips focus or the frozen column afterwards. */
async function renderDataTableView<T>(
  props: Pick<DataTableViewProps<T>, "items" | "columns" | "getItemKey" | "renderCell"> & { onSelect?: (item: T) => void },
  initial: Partial<LiveOptions> = {},
) {
  const { onSelect, ...tableProps } = props;
  const bodyRef = createRef<ScrollBoxRenderable>();
  const headerRef = createRef<ScrollBoxRenderable>();
  const state = createInitialState(createDefaultConfig("/tmp/gloom-dom-horizontal"));
  function Harness() {
    const ui = useUiHost();
    const renderer = useRendererHost();
    const [options, updateOptions] = useState<LiveOptions>({ focused: true, frozen: false, ...initial });
    setOptions = (patch) => updateOptions((current) => ({ ...current, ...patch }));
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
      <WebInputHostProvider><AppContext value={createStaticAppStore(state)}>
        <DataTableView {...tableProps} focused={options.focused} freezeFirstColumn={options.frozen}
          scrollRef={bodyRef} headerScrollRef={headerRef}
          selection={{ kind: "index", selectedIndex: 0, onChange: (_, item) => onSelect?.(item) }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}}
          emptyStateTitle="No rows" virtualize={false} />
      </AppContext></WebInputHostProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness />);
  const body = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  return { container, body, bodyRef, headerRef };
}

/** happy-dom has no layout engine, so supply the measured viewport and content widths, in cells. */
function setScrollExtent(body: HTMLElement, clientCells: number, scrollCells: number) {
  Object.defineProperty(body, "clientWidth", { configurable: true, value: clientCells * WEB_CELL_WIDTH });
  Object.defineProperty(body, "scrollWidth", { configurable: true, value: scrollCells * WEB_CELL_WIDTH });
}

test("DOM table handles expose horizontal extent to shared keyboard navigation", async () => {
  const { container, body, bodyRef, headerRef } = await renderDataTableView({
    items: [{ symbol: "ALPH", value: "$100M" }],
    columns: [{ id: "symbol", label: "TICKER", width: 60 }, { id: "value", label: "VALUE", width: 40 }],
    getItemKey: (row) => row.symbol,
    renderCell: (row, column) => ({ text: column.id === "symbol" ? row.symbol : row.value }),
  });
  setScrollExtent(body, 40, 100);
  const press = async (key: string, options: { ctrlKey?: boolean; shiftKey?: boolean; target?: HTMLElement } = {}) => {
    const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: options.ctrlKey ?? true, shiftKey: options.shiftKey });
    await act(async () => { (options.target ?? body).dispatchEvent(event as unknown as Event); });
    return event.defaultPrevented;
  };
  expect(await press("ArrowRight")).toBe(true);
  expect(body.scrollLeft).toBe(20 * WEB_CELL_WIDTH);
  expect(bodyRef.current?.scrollWidth).toBe(100);
  expect(headerRef.current?.scrollWidth).toBe(100);
  expect(headerRef.current?.scrollLeft).toBe(bodyRef.current?.scrollLeft);
  await press("ArrowRight");
  await press("ArrowRight");
  expect(body.scrollLeft).toBe(60 * WEB_CELL_WIDTH);
  await press("ArrowRight");
  expect(body.scrollLeft).toBe(60 * WEB_CELL_WIDTH);
  expect(await press("ArrowLeft")).toBe(true);
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  expect(headerRef.current?.scrollLeft).toBe(40);
  await press("ArrowRight", { ctrlKey: false });
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  await press("ArrowRight", { shiftKey: true });
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  // Shift+arrows scroll too: macOS takes Ctrl+arrows for Spaces.
  expect(await press("ArrowLeft", { ctrlKey: false, shiftKey: true })).toBe(true);
  expect(body.scrollLeft).toBe(20 * WEB_CELL_WIDTH);
  await press("ArrowRight", { ctrlKey: false, shiftKey: true });
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  const input = testWindow.document.createElement("input") as unknown as HTMLInputElement;
  container.appendChild(input);
  expect(await press("ArrowRight", { target: input })).toBe(false);
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  await act(async () => setOptions({ focused: false }));
  await press("ArrowRight");
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  await act(async () => setOptions({ focused: true }));
  body.scrollLeft = 0;
  setScrollExtent(body, 40, 40);
  expect(bodyRef.current?.scrollWidth).toBe(40);
  await press("ArrowRight");
  expect(body.scrollLeft).toBe(0);
});

test("DOM fixed axis fits covered values with ellipses and preserves selection, scrolling and ordinary tables", async () => {
  const selections: string[] = [];
  const { container, body, bodyRef, headerRef } = await renderDataTableView({
    items: ["JPY", "EUR"],
    columns: [{ id: "base", label: "", width: 5 }, ...["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"].map(id => ({ id, label: id, width: 10, align: "right" as const }))],
    getItemKey: (row) => row,
    renderCell: (row, column) => ({ text: column.id === "base" ? row : "0.0053333" }),
    onSelect: (item) => selections.push(item),
  }, { frozen: true });
  setScrollExtent(body, 48, 96);
  const rows = Array.from(container.querySelectorAll('[data-gloom-role="data-table-row"], [data-gloom-role="data-table-header-row"]')) as HTMLElement[];
  // happy-dom has no layout engine. The measured cells model the actual fixed
  // first column and scrolled grid; text remains rendered by WebDataTable.
  for (const row of rows) Array.from(row.children).forEach((cell, index) => {
    cell.getBoundingClientRect = () => {
      const left = index === 0 ? WEB_CELL_WIDTH : (7 + (index - 1) * 11) * WEB_CELL_WIDTH - body.scrollLeft;
      const width = (index === 0 ? 5 : 10) * WEB_CELL_WIDTH;
      return { left, right: left + width, width, x: left, top: 0, bottom: 18, height: 18, y: 0, toJSON: () => ({}) };
    };
  });
  const scroll = async () => { await act(async () => { body.dispatchEvent(new testWindow.Event("scroll") as unknown as Event); }); };
  await act(async () => { body.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true }) as unknown as Event); });
  await scroll();
  expect(bodyRef.current?.scrollLeft).toBe(24);
  expect(headerRef.current?.scrollLeft).toBe(24);
  for (const row of rows) {
    const cells = Array.from(row.children) as HTMLElement[];
    expect(cells[0]!.style.position).toBe("sticky");
    expect(cells[0]!.style.left).toBe("8px");
    expect(cells[3]!.style.paddingLeft).toBe("16px");
    expect((cells[3]!.firstElementChild as HTMLElement).style.textOverflow).toBe("ellipsis");
  }
  const axis = rows[2]!.children[0] as HTMLElement;
  await act(async () => { axis.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event); });
  expect(selections).toContain("EUR");
  body.scrollLeft = 48 * WEB_CELL_WIDTH; await scroll();
  expect(bodyRef.current?.scrollLeft).toBe(48);
  expect(rows[1]!.textContent).toContain("JPY");
  body.scrollLeft = 0; await scroll();
  expect((rows[1]!.children[3] as HTMLElement).style.paddingLeft).toBe("0px");
  await act(async () => setOptions({ frozen: false }));
  expect((rows[1]!.children[0] as HTMLElement).style.position).toBe("");
  expect((rows[1]!.children[3] as HTMLElement).style.paddingLeft).toBe("");
});
