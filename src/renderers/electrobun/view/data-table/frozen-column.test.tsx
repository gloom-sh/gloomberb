/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, createRef, useState } from "react";
import { DataTableView } from "../../../../components/data-table/view";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createDefaultConfig } from "../../../../types/config";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../../ui";
import type { ScrollBoxRenderable } from "../../../../ui/host";
import { WebInputHostProvider } from "../input-host";
import { WEB_CELL_WIDTH } from "../../../../theme/font-scale";
import { createDomTestHarness } from "../test-utils";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness();

test("DOM fixed axis fits covered values with ellipses and preserves selection, scrolling and ordinary tables", async () => {
  const bodyRef = createRef<ScrollBoxRenderable>();
  const headerRef = createRef<ScrollBoxRenderable>();
  const state = createInitialState(createDefaultConfig("/tmp/gloom-dom-frozen"));
  let setFrozen: (value: boolean) => void = () => {};
  const selections: string[] = [];
  function Harness() {
    const ui = useUiHost(); const renderer = useRendererHost();
    const [frozen, updateFrozen] = useState(true); setFrozen = updateFrozen;
    return <UiHostProvider ui={{ ...ui, DataTable: WebDataTable }} renderer={renderer}>
      <WebInputHostProvider><AppContext value={{ state, dispatch: () => {} }}>
        <DataTableView focused freezeFirstColumn={frozen} scrollRef={bodyRef} headerScrollRef={headerRef}
          items={["JPY", "EUR"]}
          columns={[{ id: "base", label: "", width: 5 }, ...["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"].map(id => ({ id, label: id, width: 10, align: "right" as const }))]}
          selection={{ kind: "index", selectedIndex: 0, onChange: (_, item) => selections.push(item) }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}}
          getItemKey={(row) => row} renderCell={(row, column) => ({ text: column.id === "base" ? row : "0.0053333" })}
          emptyStateTitle="No rows" virtualize={false} />
      </AppContext></WebInputHostProvider>
    </UiHostProvider>;
  }
  const container = await render(<Harness />);
  const body = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  Object.defineProperty(body, "clientWidth", { configurable: true, value: 48 * WEB_CELL_WIDTH });
  Object.defineProperty(body, "scrollWidth", { configurable: true, value: 96 * WEB_CELL_WIDTH });
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
  await act(async () => setFrozen(false));
  expect((rows[1]!.children[0] as HTMLElement).style.position).toBe("");
  expect((rows[1]!.children[3] as HTMLElement).style.paddingLeft).toBe("");
});
