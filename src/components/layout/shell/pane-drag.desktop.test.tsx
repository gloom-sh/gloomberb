/** @jsxImportSource react */
import { expect, jest, test } from "bun:test";
import { act, Profiler } from "react";
import type { PluginRegistry } from "../../../plugins/registry";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { WebToastHostProvider } from "../../../renderers/dom/toast-host";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { cloneLayout, createDefaultConfig, type LayoutConfig } from "../../../types/config";
import { Text, UiHostProvider } from "../../../ui";
import { Shell } from "./index";

const { window: testWindow, render } = createDomTestHarness({ withUi: false });

function registry(): PluginRegistry {
  const body = (label: string) => () => <Text>{label}</Text>;
  return {
    panes: new Map([
      ["portfolio-list", { id: "portfolio-list", name: "Portfolio List", component: body("Portfolio Body"), defaultPosition: "left" }],
      ["ticker-detail", {
        id: "ticker-detail",
        name: "Ticker Research",
        component: ({ width, height }: { width: number; height: number }) => <Text>{`Research ${width}x${height}`}</Text>,
        defaultPosition: "right",
      }],
    ]),
    paneTemplates: new Map(),
    commands: new Map(),
    getEnabledTickerActions: () => [],
    tickerActions: new Map(),
    brokers: new Map(),
    allPlugins: new Map(),
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    hasPaneSettings: () => false,
    notify: () => {},
    openPaneSettings: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    openWindowMode: () => {},
    updateLayout: () => {},
    hidePane: () => {},
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as unknown as PluginRegistry;
}

/** The portfolio docked alone, with Ticker Research floating at (10, 4), 40 by 12 cells. */
function floatingState() {
  const config = createDefaultConfig("/tmp/gloomberb-desktop-drag-test");
  const layout = cloneLayout(config.layout);
  const main = layout.instances.find((entry) => entry.instanceId === "portfolio-list:main")!;
  const detail = layout.instances.find((entry) => entry.instanceId === "ticker-detail:main")!;
  layout.dockRoot = { kind: "pane", instanceId: main.instanceId };
  layout.instances = [main, { ...detail, paneId: "ticker-detail" }];
  layout.floating = [{ instanceId: detail.instanceId, x: 10, y: 4, width: 40, height: 12, zIndex: 60 }];
  layout.detached = [];
  const state = createInitialState({ ...config, layout, layouts: [{ name: "Default", layout: cloneLayout(layout) }] });
  return { ...state, focusedPaneId: detail.instanceId };
}

/** The portfolio and Ticker Research docked side by side, half and half. */
function splitState() {
  const state = floatingState();
  const layout = cloneLayout(state.config.layout);
  layout.dockRoot = {
    kind: "split",
    axis: "horizontal",
    ratio: 0.5,
    first: { kind: "pane", instanceId: "portfolio-list:main" },
    second: { kind: "pane", instanceId: "ticker-detail:main" },
  };
  layout.floating = [];
  return { ...state, config: { ...state.config, layout } };
}

/** The desktop shell; counts React commits and records dispatched actions. */
async function renderDesktopShell(state = floatingState()) {
  const actions: Array<{ type: string; [key: string]: unknown }> = [];
  let commits = 0;
  const container = await render(
    <Profiler id="shell" onRender={() => { commits += 1; }}>
      <UiHostProvider ui={createDomUiHost()} renderer={noopRendererHost}>
        <WebInputHostProvider>
          <WebToastHostProvider>
            <WebDialogHostProvider>
              <AppContext value={createStaticAppStore(state, (action: { type: string }) => actions.push(action))}>
                <Shell pluginRegistry={registry()} />
              </AppContext>
            </WebDialogHostProvider>
          </WebToastHostProvider>
        </WebInputHostProvider>
      </UiHostProvider>
    </Profiler>,
  );
  return { container, actions, commits: () => commits };
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 20));

function pointer(type: "down" | "move" | "up" | "cancel", target: EventTarget, x: number, y: number) {
  const buttons = type === "down" || type === "move" ? 1 : 0;
  const init = { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: y, pointerId: 1 };
  target.dispatchEvent(new testWindow.PointerEvent(`pointer${type}`, init) as unknown as Event);
  if (type !== "cancel") target.dispatchEvent(new testWindow.MouseEvent(`mouse${type}`, init) as unknown as Event);
}

function floatingParts(container: HTMLElement) {
  const pane = container.querySelector("[data-gloom-role=pane-window][data-gloom-pane-id='ticker-detail:main']") as HTMLElement;
  return {
    pane,
    // The layer a desktop move slides: the pane's frame is laid out inside it.
    layer: pane.parentElement as HTMLElement,
    title: pane.querySelector("[data-gloom-role=pane-title]") as HTMLElement,
    handle: pane.querySelector("[data-gloom-role=resize-handle]") as HTMLElement,
  };
}

/** The px offset a layer's transform slides it by, or null. */
function slide(layer: HTMLElement): [number, number] | null {
  const match = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\)/.exec(layer.style.transform);
  return match ? [Math.round(Number(match[1])), Math.round(Number(match[2]))] : null;
}

/** Presses the floating pane's title and moves the pointer 10 cells right and 2 down, a frame per step. */
async function dragTitle(container: HTMLElement) {
  const { title } = floatingParts(container);
  const doc = testWindow.document as unknown as EventTarget;
  const x0 = 15 * 8;
  const y0 = 120;
  await act(async () => { pointer("down", title, x0, y0); });
  for (let step = 1; step <= 5; step += 1) {
    await act(async () => {
      pointer("move", doc, x0 + step * 16, y0 + step * 7.2);
      await frame();
    });
  }
  return { end: { x: x0 + 80, y: y0 + 36 } };
}

test("a desktop pane move restyles only its layer and commits once on release", async () => {
  const { container, actions, commits } = await renderDesktopShell();
  const { pane, layer, title } = floatingParts(container);
  const doc = testWindow.document as unknown as EventTarget;
  const laidOut = { left: pane.style.left, top: pane.style.top };

  await act(async () => { pointer("down", title, 120, 120); });
  // Promoted at the press, so the first move only slides it.
  expect(layer.style.willChange).toBe("transform");
  expect(slide(layer)).toEqual([0, 0]);
  await act(async () => { pointer("move", doc, 136, 127.2); await frame(); });
  const rendersBefore = commits();
  for (let step = 2; step <= 5; step += 1) {
    await act(async () => { pointer("move", doc, 120 + step * 16, 120 + step * 7.2); await frame(); });
  }
  // Every move after the first wrote a transform and rendered nothing.
  expect(commits()).toBe(rendersBefore);
  expect(slide(layer)).toEqual([80, 36]);
  expect({ left: pane.style.left, top: pane.style.top }).toEqual(laidOut);
  expect(actions.filter((action) => action.type === "UPDATE_LAYOUT")).toHaveLength(0);

  await act(async () => { pointer("up", doc, 200, 156); await frame(); });
  const updates = actions.filter((action) => action.type === "UPDATE_LAYOUT");
  expect(updates).toHaveLength(1);
  const floating = (updates[0]!.layout as LayoutConfig).floating.find((entry) => entry.instanceId === "ticker-detail:main");
  expect(floating).toMatchObject({ x: 20, width: 40, height: 12 });
  expect(floating!.y).toBeCloseTo(6);
  // The release hands the position back to layout.
  expect(layer.style.transform).toBe("");
  expect(layer.style.willChange).toBe("");
});

test.each([
  ["Escape", () => testWindow.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event)],
  ["the window losing focus", () => testWindow.dispatchEvent(new testWindow.Event("blur") as unknown as Event)],
  ["a cancelled pointer", () => pointer("cancel", testWindow.document as unknown as EventTarget, 200, 156)],
])("%s puts a moving pane back", async (_name, cancel) => {
  const { container, actions } = await renderDesktopShell();
  const { layer } = floatingParts(container);
  const { end } = await dragTitle(container);
  expect(slide(layer)).toEqual([80, 36]);

  await act(async () => { cancel(); await frame(); });
  expect(layer.style.transform).toBe("");
  await act(async () => { pointer("up", testWindow.document as unknown as EventTarget, end.x, end.y); await frame(); });
  expect(actions.filter((action) => action.type === "UPDATE_LAYOUT")).toHaveLength(0);
});

/** The width, in cells, the floating pane's content was last rendered at. */
function contentWidth(pane: HTMLElement): number | undefined {
  const match = /Research ([\d.]+)x/.exec(pane.textContent ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Presses the floating pane's corner and moves the pointer 2 cells right and 1 down per step, waiting out a frame per step. */
async function dragCorner(container: HTMLElement, steps: number, wait: () => Promise<unknown> = frame) {
  const { handle } = floatingParts(container);
  const doc = testWindow.document as unknown as EventTarget;
  await act(async () => { pointer("down", handle, 400, 300); });
  for (let step = 1; step <= steps; step += 1) {
    await act(async () => {
      pointer("move", doc, 400 + step * 16, 300 + step * 18);
      await wait();
    });
  }
  return { end: { x: 400 + steps * 16, y: 300 + steps * 18 } };
}

test("a desktop pane resize sizes its frame, which its content fills, renders the content a few times a second and commits once", async () => {
  const { container, actions, commits } = await renderDesktopShell();
  const { pane } = floatingParts(container);
  const header = pane.querySelector("[data-gloom-role=pane-header]") as HTMLElement;
  const content = pane.querySelector("[data-gloom-role=pane-content]") as HTMLElement;
  const doc = testWindow.document as unknown as EventTarget;
  // 40 by 12 cells of 8 by 18 px.
  expect({ width: pane.style.width, height: pane.style.height }).toEqual({ width: "320px", height: "216px" });
  expect(contentWidth(pane)).toBe(40);
  // Fake time drives the frames too, so the content's catch-up comes exactly when it is due.
  jest.useFakeTimers();
  try {
    const wait = async () => { jest.advanceTimersByTime(10); };
    await dragCorner(container, 1, wait);
    const rendersBefore = commits();
    for (let step = 2; step <= 4; step += 1) {
      await act(async () => { pointer("move", doc, 400 + step * 16, 300 + step * 18); await wait(); });
    }
    // Every move sized the frame and rendered nothing; the header and the
    // content box stretch with it, so what lays out by CSS follows at once,
    // and the pane is still drawn at the size it rendered at.
    expect(commits()).toBe(rendersBefore);
    expect({ width: pane.style.width, height: pane.style.height }).toEqual({ width: "384px", height: "288px" });
    expect(header.style.width).toBe("");
    expect(content.style.width).toBe("");
    expect(contentWidth(pane)).toBe(40);

    // The content catches up once, at the size the frame has now.
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(commits()).toBe(rendersBefore + 1);
    expect(contentWidth(pane)).toBe(48);
    expect(pane.style.width).toBe("384px");

    await act(async () => { pointer("up", doc, 464, 372); await wait(); });
  } finally {
    jest.useRealTimers();
  }
  const updates = actions.filter((action) => action.type === "UPDATE_LAYOUT");
  expect(updates).toHaveLength(1);
  const floating = (updates[0]!.layout as LayoutConfig).floating.find((entry) => entry.instanceId === "ticker-detail:main");
  expect(floating).toMatchObject({ x: 10, y: 4, width: 48 });
  expect(floating!.height).toBeCloseTo(16);
});

test.each([
  ["Escape", () => testWindow.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event)],
  ["the window losing focus", () => testWindow.dispatchEvent(new testWindow.Event("blur") as unknown as Event)],
  ["a cancelled pointer", () => pointer("cancel", testWindow.document as unknown as EventTarget, 464, 372)],
])("%s puts a resizing pane back at its size", async (_name, cancel) => {
  const { container, actions } = await renderDesktopShell();
  const { pane } = floatingParts(container);
  const { end } = await dragCorner(container, 4);
  // Long enough for the content to have caught up.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  expect(pane.style.width).toBe("384px");
  expect(contentWidth(pane)).toBe(48);

  await act(async () => { cancel(); await frame(); });
  expect({ width: pane.style.width, height: pane.style.height }).toEqual({ width: "320px", height: "216px" });
  expect(contentWidth(pane)).toBe(40);
  await act(async () => { pointer("up", testWindow.document as unknown as EventTarget, end.x, end.y); await frame(); });
  expect(actions.filter((action) => action.type === "UPDATE_LAYOUT")).toHaveLength(0);
});

test("a desktop pane resized from its left edge moves with the pointer and keeps its right edge", async () => {
  const { container, actions } = await renderDesktopShell();
  const { pane, layer } = floatingParts(container);
  const edge = layer.querySelector("[data-gloom-role=resize-edge][data-edge=left]") as HTMLElement;
  const doc = testWindow.document as unknown as EventTarget;
  // The pane's left edge is at cell 10 (80px).
  await act(async () => { pointer("down", edge, 80, 150); });
  for (let step = 1; step <= 4; step += 1) {
    await act(async () => { pointer("move", doc, 80 - step * 8, 150); await frame(); });
  }
  // Four cells to the left: the layer carries the move, the frame grows by as much.
  expect(slide(layer)).toEqual([-32, 0]);
  expect(pane.style.width).toBe("352px");
  await act(async () => { pointer("up", doc, 48, 150); await frame(); });
  const updates = actions.filter((action) => action.type === "UPDATE_LAYOUT");
  expect(updates).toHaveLength(1);
  const floating = (updates[0]!.layout as LayoutConfig).floating.find((entry) => entry.instanceId === "ticker-detail:main");
  expect(floating).toMatchObject({ x: 6, y: 4, width: 44, height: 12 });
  expect(layer.style.transform).toBe("");
});

test("a desktop divider drag sizes the panes on both sides as it goes, catches their content up and commits once", async () => {
  const { container, actions, commits } = await renderDesktopShell(splitState());
  const box = (paneId: string) => (container.querySelector(`[data-gloom-role=pane-window][data-gloom-pane-id='${paneId}']`) as HTMLElement).parentElement as HTMLElement;
  const left = box("portfolio-list:main");
  const right = box("ticker-detail:main");
  const divider = container.querySelector("[data-gloom-role=dock-divider]") as HTMLElement;
  const doc = testWindow.document as unknown as EventTarget;
  const px = (value: string) => Number.parseFloat(value);
  const before = { leftWidth: px(left.style.width), rightLeft: px(right.style.left), rightWidth: px(right.style.width), divider: px(divider.style.left) };
  const total = (before.leftWidth + before.rightWidth) / 8;
  const contentBefore = contentWidth(right.firstElementChild as HTMLElement)!;
  jest.useFakeTimers();
  try {
    const wait = async () => { jest.advanceTimersByTime(10); };
    await act(async () => { pointer("down", divider, before.leftWidth, 100); });
    await act(async () => { pointer("move", doc, before.leftWidth + 16, 100); await wait(); });
    const rendersBefore = commits();
    for (let step = 2; step <= 5; step += 1) {
      await act(async () => { pointer("move", doc, before.leftWidth + step * 16, 100); await wait(); });
    }
    // Ten cells right: both panes and the divider moved with it, and nothing rendered.
    expect(commits()).toBe(rendersBefore);
    expect(px(left.style.width)).toBe(before.leftWidth + 80);
    expect(px(right.style.left)).toBe(before.rightLeft + 80);
    expect(px(right.style.width)).toBe(before.rightWidth - 80);
    expect(px(divider.style.left)).toBe(before.divider + 80);
    expect(contentWidth(right.firstElementChild as HTMLElement)).toBe(contentBefore);

    // The content catches up once, at the width its pane has now.
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(commits()).toBe(rendersBefore + 1);
    expect(contentWidth(right.firstElementChild as HTMLElement)).toBe(contentBefore - 10);

    await act(async () => { pointer("up", doc, before.leftWidth + 80, 100); await wait(); });
  } finally {
    jest.useRealTimers();
  }
  const updates = actions.filter((action) => action.type === "UPDATE_LAYOUT");
  expect(updates).toHaveLength(1);
  const root = (updates[0]!.layout as LayoutConfig).dockRoot;
  expect(root?.kind === "split" ? root.ratio : null).toBeCloseTo(0.5 + 10 / total);
});
