/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, createRef, useState } from "react";
import { DataTableView } from "../../../../components/data-table/view";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createDefaultConfig } from "../../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../../ui";
import type { ScrollBoxRenderable } from "../../../../ui/host";
import { WEB_CELL_WIDTH, WebInputHostProvider } from "../input-host";
import { createDomTestHarness } from "../test-utils";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness();

test("DOM table handles expose horizontal extent to shared keyboard navigation", async () => {
  const bodyRef = createRef<ScrollBoxRenderable>();
  const headerRef = createRef<ScrollBoxRenderable>();
  const state = createInitialState(createDefaultConfig("/tmp/gloom-dom-horizontal"));
  let setFocused: (value: boolean) => void = () => {};
  function Harness() {
    const ui = useUiHost();
    const renderer = useRendererHost();
    const [focused, updateFocused] = useState(true);
    setFocused = updateFocused;
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
      <WebInputHostProvider><AppContext value={{ state, dispatch: () => {} }}>
        <DataTableView focused={focused} scrollRef={bodyRef} headerScrollRef={headerRef}
          items={[{ symbol: "ALPH", value: "$100M" }]}
          columns={[{ id: "symbol", label: "TICKER", width: 60 }, { id: "value", label: "VALUE", width: 40 }]}
          selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}}
          getItemKey={(row) => row.symbol} renderCell={(row, column) => ({ text: column.id === "symbol" ? row.symbol : row.value })}
          emptyStateTitle="No rows" virtualize={false} />
      </AppContext></WebInputHostProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness />);
  const body = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  // happy-dom has no layout engine; supply measured browser pixel dimensions.
  Object.defineProperty(body, "clientWidth", { configurable: true, value: 40 * WEB_CELL_WIDTH });
  Object.defineProperty(body, "scrollWidth", { configurable: true, value: 100 * WEB_CELL_WIDTH });
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
  await act(async () => setFocused(false));
  await press("ArrowRight");
  expect(body.scrollLeft).toBe(40 * WEB_CELL_WIDTH);
  await act(async () => setFocused(true));
  body.scrollLeft = 0;
  Object.defineProperty(body, "scrollWidth", { configurable: true, value: 40 * WEB_CELL_WIDTH });
  expect(bodyRef.current?.scrollWidth).toBe(40);
  await press("ArrowRight");
  expect(body.scrollLeft).toBe(0);
});
