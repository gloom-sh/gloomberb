/** @jsxImportSource react */
import { expect, jest, test } from "bun:test";
import { act, startTransition, Suspense, useRef, useState, type CSSProperties } from "react";
import { WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { beginLiveResize } from "../../../ui/live-resize";
import { LivePaneFrameContext, type LivePaneFrame } from "../../../ui/live-stretch";
import { RESIZE_SETTLE_MS, useSettledLayoutSize } from "../../../ui/resize-settle";
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

test("regrabbing a shrinking table preserves its painted width instead of jumping to its destination", async () => {
  let resize: (width: number) => void = () => {};
  let paintedWidth = 1_040;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    const [naturalWidth, setNaturalWidth] = useState(1_000);
    resize = setNaturalWidth;
    useTableResizeColumns(ref, `minmax(20px, ${naturalWidth}fr)`, "value", {
      naturalWidth, viewportWidth: 100, viewportIsCurrent: () => true,
      fillAvailableWidth: true, showHorizontalScrollbar: true,
    });
    return <div ref={ref} style={{ ...TABLE_RESIZE_DEFAULTS }}>
      <div data-gloom-role="data-table-scroll-content" />
    </div>;
  }
  const container = await render(<Harness />);
  const table = container.firstElementChild as HTMLElement;
  const content = table.firstElementChild as HTMLElement;
  content.getBoundingClientRect = () => new testWindow.DOMRect(0, 0, paintedWidth, 240) as unknown as DOMRect;
  let end = beginLiveResize();
  try {
    // A fresh drag can shrink through the spare space above the natural width.
    expect(table.style.getPropertyValue("--gloom-table-resize-width")).toBe("max(100%, 1000px)");
    await act(async () => resize(900));
    end();
    // The browser has painted only part of the transition to the new width.
    paintedWidth = 950;
    end = beginLiveResize();
    expect(table.style.getPropertyValue("--gloom-table-column-transition")).toBe("initial");
    expect(table.style.getPropertyValue("--gloom-table-resize-width")).toBe("max(100%, 950px)");
  } finally {
    end();
  }
});

test.each([false, true])("releasing an authored minimum preserves the painted tracks (empty: %s)", async (empty) => {
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTableResizeColumns(ref, "minmax(10px, 100fr) minmax(10px, 100fr)", "label,value", {
      naturalWidth: 200, resizeWidth: 100, viewportWidth: 25, viewportIsCurrent: () => true,
      fillAvailableWidth: true, showHorizontalScrollbar: true,
    });
    return <div ref={ref} style={{ ...TABLE_RESIZE_DEFAULTS }}>
      <div data-gloom-role="data-table-scroll-content" style={{ gridTemplateColumns: empty ? "none" : "120px 80px" }}>
        {empty ? <div data-gloom-role="data-table-header-row" style={{ gridTemplateColumns: "120px 80px" }} /> : null}
      </div>
    </div>;
  }
  const container = await render(<Harness />);
  const end = beginLiveResize();
  try {
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue("--gloom-table-resize-columns"))
      .toBe("minmax(min(10px, 120px), 120fr) minmax(min(10px, 80px), 80fr)");
  } finally {
    end();
  }
});

test.each([
  ["authored", 80, 20, 40, 60],
  ["zero", 0, 0, 60, 90],
  ["invalid", Infinity, 20, 60, 90],
  ["partial", 0.25, 0.25, 60, 90],
] as const)("regrabbing preserves painted ratios and header floors with %s weights", async (_kind, firstWeight, secondWeight, firstPainted, secondPainted) => {
  let widenHeaders: () => void = () => {};
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    const [wide, setWide] = useState(false);
    widenHeaders = () => setWide(true);
    useTableResizeColumns(ref, wide
      ? `minmax(calc(8 * var(--cell-w)), 100px) minmax(calc(9 * var(--cell-w)), ${firstWeight}fr) minmax(calc(12 * var(--cell-w)), ${secondWeight}fr)`
      : `minmax(40px, 100px) minmax(40px, ${firstWeight}fr) minmax(40px, ${secondWeight}fr)`, "impact,country,event", {
      naturalWidth: 300, resizeWidth: 200, viewportWidth: 25, viewportIsCurrent: () => true,
      fillAvailableWidth: true, showHorizontalScrollbar: true,
    });
    return <div ref={ref} style={{ ...TABLE_RESIZE_DEFAULTS }}>
      <div data-gloom-role="data-table-scroll-content" style={{ gridTemplateColumns: "50px 60px 90px" }} />
    </div>;
  }
  const container = await render(<Harness />);
  const table = container.firstElementChild as HTMLElement;
  let end = beginLiveResize();
  try {
    end();
    // A responsive label expands on release. The browser is still painting
    // halfway to its new minimum when the pointer grabs the edge again.
    await act(async () => widenHeaders());
    end = beginLiveResize();
    expect(table.style.getPropertyValue("--gloom-table-column-transition")).toBe("initial");
    // Normalize the fr total without changing the 2:3 painted ratio or the
    // fixed 50px track. New header minima must still cap to the painted widths.
    expect(table.style.getPropertyValue("--gloom-table-resize-columns")).toBe(
      `minmax(min(calc(8 * var(--cell-w)), 50px), 50px) minmax(min(calc(9 * var(--cell-w)), 60px), ${firstPainted}fr) minmax(min(calc(12 * var(--cell-w)), 90px), ${secondPainted}fr)`,
    );
  } finally {
    end();
  }
});

test.each([0, 8])("responsive presses and regrabs use the fractional inner viewport with a %ipx scrollbar", async (scrollbarWidth) => {
  let viewport = 900.25;
  let paintedWidth = 950.5;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTableResizeColumns(ref, "minmax(20px, 1000fr)", "value", {
      naturalWidth: 1_000, resizeWidth: 700, viewportWidth: 113, viewportIsCurrent: () => true,
      fillAvailableWidth: true, showHorizontalScrollbar: true,
    });
    return <div ref={ref} style={{ ...TABLE_RESIZE_DEFAULTS }}>
      <div data-gloom-role="data-table-body-scroll">
        <div data-gloom-role="data-table-scroll-content" />
      </div>
    </div>;
  }
  const container = await render(<Harness />);
  const table = container.firstElementChild as HTMLElement;
  const body = table.firstElementChild as HTMLElement;
  const content = body.firstElementChild as HTMLElement;
  Object.defineProperties(body, {
    clientWidth: { get: () => Math.round(viewport) },
    offsetWidth: { get: () => Math.round(viewport + scrollbarWidth) },
  });
  body.getBoundingClientRect = () => new testWindow.DOMRect(0, 0, viewport + scrollbarWidth, 240) as unknown as DOMRect;
  content.getBoundingClientRect = () => new testWindow.DOMRect(0, 0, paintedWidth, 240) as unknown as DOMRect;
  let end = beginLiveResize();
  try {
    // CSS 100% resolves to 900.25px: subtracting the border box would move
    // painted overflow by the scrollbar width as soon as the pointer presses.
    expect(table.style.getPropertyValue("--gloom-table-resize-width"))
      .toBe("max(100%, 700px, calc(950.5px + min(0px, calc(100% - 900.25px))))");
    end();
    viewport = 870.75;
    paintedWidth = 920.125;
    end = beginLiveResize();
    expect(table.style.getPropertyValue("--gloom-table-resize-width"))
      .toBe("max(100%, 700px, calc(920.125px + min(0px, calc(100% - 870.75px))))");
  } finally {
    end();
  }
});

test("a late layout commit gets a whole settling transition without holding another pane or later data updates", async () => {
  jest.useFakeTimers();
  const delayed = Promise.withResolvers<void>();
  let blocked = true;
  const updates = new Map<string, { resize: (width: number) => void; retarget: (extra: number) => void }>();
  const frame = (): LivePaneFrame => ({
    resizeLayoutScope: {}, rendered: { width: 80, height: 24 },
    live: () => null, subscribe: () => () => {},
  });
  function Gate({ width, slow }: { width: number; slow: boolean }) {
    if (slow && width !== 80 && blocked) throw delayed.promise;
    return null;
  }
  function Table({ id, width }: { id: string; width: number }) {
    const ref = useRef<HTMLDivElement>(null);
    const [extra, retarget] = useState(0);
    updates.get(id)!.retarget = retarget;
    const template = `minmax(20px, ${width + extra}fr)`;
    useTableResizeColumns(ref, template, "value", {
      naturalWidth: (width + extra) * WEB_CELL_WIDTH, viewportWidth: width,
      viewportIsCurrent: () => true, fillAvailableWidth: true, showHorizontalScrollbar: true,
    });
    return <div id={id} ref={ref} data-width={width} style={{ ...TABLE_RESIZE_DEFAULTS }}>
      <div data-gloom-role="data-table-scroll-content" style={{ gridTemplateColumns: template }} />
    </div>;
  }
  function Parent({ id, slow = false }: { id: string; slow?: boolean }) {
    const [width, resize] = useState(80);
    updates.set(id, { resize, retarget: updates.get(id)?.retarget ?? (() => {}) });
    const layout = useSettledLayoutSize(width, 24, { maxStretch: Infinity });
    return <><Table id={id} width={layout.width} /><Gate width={layout.width} slow={slow} /></>;
  }
  const transition = (table: HTMLElement) => table.style.getPropertyValue("--gloom-table-column-transition");
  const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  let end: (() => void) | null = null;
  try {
    const container = await render(
      <LivePaneFrameContext.Provider value={frame()}><Suspense fallback={null}><Parent id="late" slow /></Suspense></LivePaneFrameContext.Provider>
    );
    const readyContainer = await render(<LivePaneFrameContext.Provider value={frame()}><Parent id="ready" /></LivePaneFrameContext.Provider>);
    const late = container.querySelector<HTMLElement>("#late")!;
    const ready = readyContainer.querySelector<HTMLElement>("#ready")!;
    end = beginLiveResize();
    await act(async () => {
      updates.get("late")!.resize(96);
      updates.get("ready")!.resize(96);
    });
    end();
    // The held width's timer fires, but its parent cannot commit yet. The
    // previously committed table stays visible throughout the transition.
    await act(async () => startTransition(() => jest.advanceTimersByTime(RESIZE_SETTLE_MS)));
    await advance(RESIZE_SETTLE_MS * 2);
    expect(late.dataset.width).toBe("80");
    expect(transition(late)).toContain("grid-template-columns");
    expect(transition(ready)).toBe("initial");

    // Regrabbing while no cleanup timer is armed still cancels the phase.
    end = beginLiveResize();
    expect(transition(late)).toBe("initial");
    end();
    await act(async () => { blocked = false; delayed.resolve(); });
    expect(late.dataset.width).toBe("96");
    await advance(RESIZE_SETTLE_MS / 2);
    await act(async () => updates.get("late")!.retarget(8));
    await advance(RESIZE_SETTLE_MS - 1);
    expect(transition(late)).toContain("grid-template-columns");
    await advance(1);
    expect(transition(late)).toBe("initial");
    await act(async () => updates.get("late")!.retarget(16));
    expect(transition(late)).toBe("initial");
  } finally {
    end?.();
    await act(async () => { blocked = false; delayed.resolve(); });
    jest.useRealTimers();
  }
});

test.each([["normal", false], ["reduced", true]] as const)("unmounting a held layout lets its table finish settling (%s motion)", async (_name, reducedMotion) => {
  jest.useFakeTimers();
  const previousMotion = testWindow.happyDOM.settings.device.prefersReducedMotion;
  testWindow.happyDOM.settings.device.prefersReducedMotion = reducedMotion ? "reduce" : "no-preference";
  let resize: (width: number) => void = () => {};
  let removeHold: () => void = () => {};
  function Hold() {
    const [width, setWidth] = useState(80);
    resize = setWidth;
    useSettledLayoutSize(width, 24);
    return null;
  }
  function Harness() {
    const [show, setShow] = useState(true);
    removeHold = () => setShow(false);
    const ref = useRef<HTMLDivElement>(null);
    useTableResizeColumns(ref, "minmax(20px, 1fr)", "value", {
      naturalWidth: 800, viewportWidth: 100, viewportIsCurrent: () => true,
      fillAvailableWidth: true, showHorizontalScrollbar: true,
    });
    return <>{show && <Hold />}<div ref={ref} style={{ ...TABLE_RESIZE_DEFAULTS }} /></>;
  }
  let end: (() => void) | null = null;
  try {
    const container = await render(<Harness />);
    const table = container.firstElementChild as HTMLElement;
    end = beginLiveResize();
    await act(async () => resize(90));
    end();
    await act(async () => removeHold());
    await act(async () => { jest.advanceTimersByTime(RESIZE_SETTLE_MS - 1); });
    expect(table.style.getPropertyValue("--gloom-table-column-transition")).toBe(reducedMotion
      ? "initial" : `grid-template-columns ${RESIZE_SETTLE_MS}ms linear, width ${RESIZE_SETTLE_MS}ms linear`);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(table.style.getPropertyValue("--gloom-table-column-transition")).toBe("initial");
  } finally {
    end?.();
    testWindow.happyDOM.settings.device.prefersReducedMotion = previousMotion;
    jest.useRealTimers();
  }
});
