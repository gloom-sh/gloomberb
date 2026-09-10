/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "../../../../ui/host";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createDefaultConfig } from "../../../../types/config";
import type { DataTableVisibleRange } from "../../../../components/ui/data-table";
import { useTableBodyScrollActivity } from "../../../../components/table-view-shared";
import { createDomTestHarness } from "../test-utils";
import { WEB_CELL_HEIGHT } from "../input-host";
import { WebDataTable } from ".";

const { window: testWindow, render } = createDomTestHarness({ withUi: false });
const items = Array.from({ length: 100 }, (_, index) => index);

test("controlled centering keeps following late quotes until the user scrolls", async () => {
  let updateQuoteTarget: (index: number) => void = () => {};
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
      <AppContext value={{ state, dispatch: () => {} }}>
        <WebDataTable
          items={items}
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
  Object.defineProperty(body, "clientHeight", { configurable: true, value: WEB_CELL_HEIGHT * 11 });
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

  await act(async () => {
    body.dispatchEvent(new testWindow.WheelEvent("wheel", { bubbles: true, deltaY: -50 }) as unknown as Event);
    body.scrollTop = 0;
    emitScroll();
    await settle();
  });
  expect(userScrolls).toBe(1);
  expect(paginationChecks).toBe(3);
  expect(ranges.at(-1)).toEqual({ start: 0, end: 10 });

  await act(async () => { updateQuoteTarget(60); await settle(); });
  expect(body.scrollTop).toBe(0);
});
