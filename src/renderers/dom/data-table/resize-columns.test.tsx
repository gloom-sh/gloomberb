/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useRef, useState, type CSSProperties } from "react";
import { WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { beginLiveResize } from "../../../ui/live-resize";
import { RESIZE_SETTLE_MS } from "../../../ui/resize-settle";
import { createDomTestHarness } from "../test-utils";
import { TABLE_RESIZE_DEFAULTS, useTableResizeColumns } from "./resize-columns";

const { window: testWindow, render } = createDomTestHarness({ withUi: false });

test("a resize holds its overflow extent through catch-ups and until the final viewport measurement lands", async () => {
  let viewport = 160 * WEB_CELL_WIDTH;
  let update: (width: { naturalWidth: number; viewportWidth: number }) => void = () => {};
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState({ naturalWidth: 900, viewportWidth: 160 });
    update = setWidth;
    useTableResizeColumns(ref, `minmax(20px, ${width.naturalWidth}fr)`, "value", {
      ...width, fillAvailableWidth: true, showHorizontalScrollbar: true,
      viewportIsCurrent: () => viewport === width.viewportWidth * WEB_CELL_WIDTH,
    });
    return <div ref={ref} data-gloom-role="data-table" style={{ ...TABLE_RESIZE_DEFAULTS }}>
      <div data-gloom-role="data-table-body-scroll">
        <div data-gloom-role="data-table-scroll-content" />
      </div>
    </div>;
  }
  const outerHold: CSSProperties & Record<`--${string}`, string> = {
    "--gloom-table-resize-width": "2000px",
    "--gloom-table-resize-columns": "minmax(20px, 2fr)",
    "--gloom-table-column-transition": "width 30s linear",
  };
  const container = await render(<div style={outerHold}><Harness /></div>);
  const table = container.querySelector<HTMLElement>('[data-gloom-role="data-table"]')!;
  const body = table.querySelector<HTMLElement>('[data-gloom-role="data-table-body-scroll"]')!;
  const content = table.querySelector<HTMLElement>('[data-gloom-role="data-table-scroll-content"]')!;
  Object.defineProperty(body, "clientWidth", { get: () => viewport });
  content.getBoundingClientRect = () => new testWindow.DOMRect(0, 0, viewport, 240) as unknown as DOMRect;

  const end = beginLiveResize();
  try {
    const held = table.style.getPropertyValue("--gloom-table-resize-width");
    expect(held).toBe("max(100%, 900px)");
    await act(async () => update({ naturalWidth: 1_000, viewportWidth: 160 }));
    expect(table.style.getPropertyValue("--gloom-table-resize-width")).toBe(held);

    viewport = 90 * WEB_CELL_WIDTH;
    end();
    // Releasing before the observer's measurement commits must not expose
    // the stale 100% rest width and then expand back to the natural extent.
    expect(table.style.getPropertyValue("--gloom-table-resize-width")).toBe(held);
    await act(async () => update({ naturalWidth: 1_000, viewportWidth: 90 }));
    // The outer table can still be held while this one finishes. Clearing an
    // inline declaration would inherit its width and tracks into this table.
    const inactive = testWindow.getComputedStyle(table as unknown as InstanceType<typeof testWindow.HTMLElement>);
    expect(inactive.getPropertyValue("--gloom-table-resize-width")).toBe("initial");
    expect(inactive.getPropertyValue("--gloom-table-resize-columns")).toBe("initial");
    await new Promise((resolve) => setTimeout(resolve, RESIZE_SETTLE_MS * 2 + 10));
    expect(testWindow.getComputedStyle(table as unknown as InstanceType<typeof testWindow.HTMLElement>)
      .getPropertyValue("--gloom-table-column-transition")).toBe("initial");
  } finally {
    end();
  }
});
