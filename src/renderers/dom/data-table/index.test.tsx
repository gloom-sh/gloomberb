/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { tableHeaderPx } from "./dom";
import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "../../../ui/host";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import { WebInputHostProvider } from "../input-host";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import type { DataTableVisibleRange } from "../../../components/ui/data-table";
import { useTableBodyScrollActivity } from "../../../components/table-view-shared";
import { createDomTestHarness } from "../test-utils";
import { WEB_CELL_HEIGHT } from "../../../theme/font-scale";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness();
const items = Array.from({ length: 100 }, (_, index) => index);

test("controlled centering keeps following late quotes until the user scrolls", async () => {
  let updateQuoteTarget: (index: number) => void = () => {};
  let updateItems: (next: number[]) => void = () => {};
  let userScrolls = 0;
  let controlledScrolls = 0;
  let paginationChecks = 0;
  const ranges: DataTableVisibleRange[] = [];
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-test"));

  function Harness() {
    const headerScrollRef = useRef<ScrollBoxRenderable | null>(null);
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    const userScrolled = useRef(false);
    const [targetIndex, setTargetIndex] = useState(0);
    const [currentItems, setCurrentItems] = useState(items);
    updateItems = setCurrentItems;
    // Options waits for the underlying quote, then follows it until an actual
    // user scroll. The renderer must not turn its own centering into that lock.
    updateQuoteTarget = (index) => {
      if (!userScrolled.current) setTargetIndex(index);
    };
    const onBodyScrollActivity = useTableBodyScrollActivity({
      syncHeaderScroll: () => {},
      onBodyScrollActivity: (source) => {
        if (source === "programmatic") {
          controlledScrolls += 1;
          return;
        }
        userScrolled.current = true;
        userScrolls += 1;
      },
      afterScroll: () => { paginationChecks += 1; },
    });
    return (
      <AppContext value={createStaticAppStore(state)}>
        <WebDataTable
          items={currentItems}
          columns={[{ id: "strike", label: "Strike", width: 10, align: "right" }]}
          sortColumnId={null}
          sortDirection="asc"
          onHeaderClick={() => {}}
          headerScrollRef={headerScrollRef}
          scrollRef={scrollRef}
          syncHeaderScroll={() => {}}
          onBodyScrollActivity={onBodyScrollActivity}
          onVisibleRangeChange={(range) => ranges.push(range)}
          getItemKey={String}
          isSelected={(_item, index) => index === targetIndex}
          onSelect={() => {}}
          renderCell={(item) => ({ text: String(item) })}
          emptyStateTitle="No strikes"
          virtualize={false}
          scrollToIndex={targetIndex}
          scrollToIndexAlign="center"
        />
      </AppContext>
    );
  }

  const container = await render(<Harness />);
  const body = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  // A header row plus ten body rows.
  Object.defineProperty(body, "clientHeight", { configurable: true, value: tableHeaderPx() + WEB_CELL_HEIGHT * 10 });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  const emitScroll = () => body.dispatchEvent(new testWindow.Event("scroll") as unknown as Event);

  await act(async () => { updateQuoteTarget(40); });
  await act(async () => {
    // happy-dom does not emit the native event when scrollTop is assigned.
    emitScroll();
    await settle();
  });
  expect(body.scrollTop).toBe(35 * WEB_CELL_HEIGHT);
  expect(ranges.at(-1)).toEqual({ start: 35, end: 45 });
  expect(userScrolls).toBe(0);
  expect(controlledScrolls).toBe(1);

  await act(async () => { updateQuoteTarget(50); });
  await act(async () => { emitScroll(); await settle(); });
  expect(body.scrollTop).toBe(45 * WEB_CELL_HEIGHT);
  expect(userScrolls).toBe(0);
  expect(controlledScrolls).toBe(2);

  // An uncached options expiry empties the table while loading. The browser
  // clamps the old scroll offset to zero when its scrollable content vanishes.
  // That native scroll event must not lock out the next expiry's ATM selection.
  await act(async () => { updateItems([]); });
  await act(async () => {
    body.scrollTop = 0;
    emitScroll();
    await settle();
  });
  expect(userScrolls).toBe(0);
  await act(async () => { updateItems(items); updateQuoteTarget(60); });
  await act(async () => { emitScroll(); await settle(); });
  expect(body.scrollTop).toBe(55 * WEB_CELL_HEIGHT);
  expect(userScrolls).toBe(0);

  await act(async () => {
    body.dispatchEvent(new testWindow.WheelEvent("wheel", { bubbles: true, deltaY: -50 }) as unknown as Event);
    body.scrollTop = 0;
    emitScroll();
    await settle();
  });
  expect(userScrolls).toBe(1);
  expect(paginationChecks).toBe(4);
  expect(ranges.at(-1)).toEqual({ start: 0, end: 10 });

  await act(async () => { updateQuoteTarget(70); await settle(); });
  expect(body.scrollTop).toBe(0);
});

test("an opted-in table draws the selected row in selection text unless a cell keeps its tone", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-test"));
  function Harness() {
    const headerScrollRef = useRef<ScrollBoxRenderable | null>(null);
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <AppContext value={createStaticAppStore(state)}>
        <WebDataTable
          items={["a", "b"]}
          columns={[
            { id: "name", label: "Name", width: 6 },
            { id: "pnl", label: "P&L", width: 6, align: "right" },
          ]}
          sortColumnId={null}
          sortDirection="asc"
          headerScrollRef={headerScrollRef}
          scrollRef={scrollRef}
          syncHeaderScroll={() => {}}
          onBodyScrollActivity={() => {}}
          getItemKey={String}
          isSelected={(item) => item === "a"}
          onSelect={() => {}}
          renderCell={(item, column) => column.id === "pnl"
            ? { text: "+1", color: "#00ff00", keepColorWhenSelected: true }
            : { text: item, color: "#999999" }}
          selectedTextOverridesCellColor
          emptyStateTitle="No rows"
          virtualize={false}
        />
      </AppContext>
    );
  }

  const container = await render(<Harness />);
  const colorsByRow = [...container.querySelectorAll('[data-gloom-role="data-table-row"]')].map((row) => (
    [...row.querySelectorAll("span")].map((span) => (span as HTMLElement).style.color)
  ));
  expect(colorsByRow).toEqual([
    ["var(--gloom-selected-text)", "#00ff00"],
    ["#999999", "#00ff00"],
  ]);
});

test("artwork before a label is hidden decoration: the text keeps its selection color and a press on it selects the row", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-test"));
  const selected: string[] = [];
  function Harness() {
    const headerScrollRef = useRef<ScrollBoxRenderable | null>(null);
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <AppContext value={createStaticAppStore(state)}>
        <WebDataTable
          items={["a", "b"]}
          columns={[
            { id: "name", label: "", width: 6 },
            { id: "rate", label: "Rate", width: 8, align: "right", headerLeading: <i data-art="header" /> },
          ]}
          sortColumnId={null}
          sortDirection="asc"
          headerScrollRef={headerScrollRef}
          scrollRef={scrollRef}
          syncHeaderScroll={() => {}}
          onBodyScrollActivity={() => {}}
          getItemKey={String}
          isSelected={(item) => item === "a"}
          onSelect={(item) => selected.push(item)}
          renderCell={(item, column) => column.id === "name"
            ? { text: item, color: "#999999", leading: <i data-art={`row-${item}`} /> }
            : { text: "1.0" }}
          selectedTextOverridesCellColor
          emptyStateTitle="No rows"
          virtualize={false}
        />
      </AppContext>
    );
  }

  const container = await render(<Harness />);
  const leading = [...container.querySelectorAll('[data-gloom-role="data-table-leading"]')];
  expect(leading).toHaveLength(3);
  expect(leading.every((node) => node.getAttribute("aria-hidden") === "true")).toBe(true);

  const rowA = container.querySelector('[data-gloom-row-key="a"]')!;
  expect((rowA.querySelector("span[title]") as HTMLElement).style.color).toBe("var(--gloom-selected-text)");
  expect(rowA.textContent).toBe("a1.0");
  const header = container.querySelectorAll('[data-gloom-role="data-table-header-cell"]')[1] as HTMLElement;
  expect(header.textContent).toBe("Rate");
  expect(header.style.justifyContent).toBe("flex-end");

  const art = container.querySelector('[data-art="row-b"]')!;
  await act(async () => { art.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event); });
  expect(selected).toEqual(["b"]);
});

test("the pane scroll keys scroll a table body, as they do in the terminal", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-test"));
  function Harness() {
    const headerScrollRef = useRef<ScrollBoxRenderable | null>(null);
    const scrollRef = useRef<ScrollBoxRenderable | null>(null);
    return (
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="table-keys:test">
          <WebInputHostProvider>
            <PaneKeyboardScrollController paneId="table-keys:test" focused />
            <WebDataTable
              items={items}
              columns={[{ id: "row", label: "Row", width: 10, align: "right" }]}
              sortColumnId={null}
              sortDirection="asc"
              onHeaderClick={() => {}}
              headerScrollRef={headerScrollRef}
              scrollRef={scrollRef}
              syncHeaderScroll={() => {}}
              getItemKey={String}
              isSelected={() => false}
              onSelect={() => {}}
              renderCell={(item) => ({ text: String(item) })}
              emptyStateTitle="No rows"
              virtualize={false}
            />
          </WebInputHostProvider>
        </PaneInstanceProvider>
      </AppContext>
    );
  }

  const container = await render(<Harness />);
  const body = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
  // A header row plus ten body rows in a table of a hundred.
  Object.defineProperty(body, "clientHeight", { configurable: true, value: tableHeaderPx() + WEB_CELL_HEIGHT * 10 });
  Object.defineProperty(body, "scrollHeight", { configurable: true, value: tableHeaderPx() + WEB_CELL_HEIGHT * items.length });
  const press = async (key: string) => {
    const event = new testWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => { testWindow.document.body.dispatchEvent(event); await Promise.resolve(); });
  };

  await press("PageDown");
  expect(body.scrollTop).toBe(9 * WEB_CELL_HEIGHT);
  await press("End");
  expect(body.scrollTop).toBe(90 * WEB_CELL_HEIGHT);
  await press("Home");
  expect(body.scrollTop).toBe(0);
});
