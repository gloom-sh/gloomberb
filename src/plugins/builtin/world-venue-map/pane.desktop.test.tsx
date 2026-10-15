/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { setCloudApiFetchTransport, type CloudWorldVenueMapPayload } from "../../../api-client";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { answerGeoFixture } from "../../../test-support/test-fixture-geo";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { WEB_CELL_WIDTH } from "../../../theme/font-scale";
import { UiHostProvider } from "../../../ui";
import { WorldVenueMapPane } from "./pane";

const dom = createDomTestHarness({ withUi: false });

afterEach(() => {
  setCloudApiFetchTransport(null);
  resetGeoCatalogCache();
});

const venues: CloudWorldVenueMapPayload = {
  checkedAt: Date.now(),
  refreshAt: Date.now() + 60_000,
  venues: ["XNYS", "XLON", "XTKS"].map((mic, index) => ({
    mic, name: mic, title: `Exchange ${mic}`, country: "Testland", countryCode: "TL", city: `City ${index}`,
    timezone: "UTC", latitude: 40 + index * 3, longitude: -74 + index * 40, isOpen: index === 0,
  })),
} as CloudWorldVenueMapPayload;

function serve() {
  setCloudApiFetchTransport(async (url) => {
    const { pathname, search } = new URL(String(url));
    if (pathname === "/market/venues") return Response.json({ data: venues });
    if (pathname.startsWith("/cloud/geo/")) return Response.json(answerGeoFixture(pathname.slice("/cloud/geo/".length) + search));
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
}

const PANE_ID = "world-venue-map:desktop-test";

function Pane({ settings }: { settings: Record<string, unknown> }) {
  const [state, dispatch] = useReducer(appReducer, settings, (initial) => ({
    ...createInitialState(createTestPaneConfig("/tmp/world-map-desktop-test", { paneId: "world-venue-map", instanceId: PANE_ID, settings: initial })),
    focusedPaneId: PANE_ID,
  }));
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="market-overview" runtime={createTestPluginRuntime()} width={130} height={32} footerKeys>
          {(body) => <WorldVenueMapPane paneId={PANE_ID} paneType="world-venue-map" width={body.width} height={body.height} focused />}
        </TestPaneFrame>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

const mount = (settings: Record<string, unknown>) => dom.render(<Pane settings={settings} />);

/** A key as the desktop and the web report it, to the window the input host listens on. */
async function press(key: string, init: { shiftKey?: boolean } = {}) {
  const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    dom.window.dispatchEvent(event);
    await Bun.sleep(10);
  });
  return event;
}

async function until(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 100 && !container.textContent?.includes(text); attempt += 1) {
    await act(async () => { await Bun.sleep(20); });
  }
  expect(container.textContent).toContain(text);
}

const sidebarCells = (container: HTMLElement) => Number.parseFloat((container.querySelector('[data-gloom-role="pane-sidebar"]') as HTMLElement).style.width) / WEB_CELL_WIDTH;
const basemap = (container: HTMLElement) => container.querySelector('[data-gloom-role="basemap"]')!.getAttribute("transform")!;
const hints = (container: HTMLElement) => [...container.querySelectorAll('[data-gloom-role="pane-hint"]')].map((hint) => hint.textContent?.trim()).join(" ");

describe("MAP on the desktop and the web", () => {
  test("< and > narrow and widen the sidebar from the keyboard without a footer hint", async () => {
    serve();
    const container = await mount({ layers: [], venues: true });
    await until(container, "City 0");
    expect(hints(container)).toContain("zoom in");
    expect(hints(container)).not.toContain("sidebar");
    expect(hints(container)).not.toContain("[<]");
    const start = sidebarCells(container);

    // Shift+comma and Shift+period on a US layout report these characters.
    await press("<", { shiftKey: true });
    expect(sidebarCells(container)).toBe(start - 4);
    await press(">", { shiftKey: true });
    await press(">", { shiftKey: true });
    expect(sidebarCells(container)).toBe(start + 4);
  });

  test("the arrow keys move the list until the map is given them, then pan it, and Esc gives them back", async () => {
    serve();
    const container = await mount({ layers: [], venues: true });
    await until(container, "City 0");
    // Zoom in so there is somewhere to pan to.
    for (let step = 0; step < 4; step += 1) await press("+", { shiftKey: true });
    const zoomed = basemap(container);

    // The list has the arrows: its cursor moves to the next venue and the map follows it.
    const header = () => container.querySelector('[data-gloom-role="world-venue-map"]')!.parentElement!.textContent ?? "";
    expect(header()).toContain("City 0");
    await press("ArrowDown");
    expect(header()).toContain("City 1");

    await press("m");
    expect(hints(container)).toContain("[Esc] list");
    const handedOver = basemap(container);
    // Pressing m moved nothing; an arrow now pans, Shift pans further, and the list's cursor stays where it was.
    await press("ArrowRight");
    const [a, , , , x0] = handedOver.slice(7, -1).split(" ").map(Number) as [number, number, number, number, number, number];
    const [, , , , x1] = basemap(container).slice(7, -1).split(" ").map(Number) as [number, number, number, number, number, number];
    expect(basemap(container)).not.toBe(handedOver);
    // Right moves the view east, so the land moves west by an eighth of the view.
    expect(x1).toBeLessThan(x0!);
    expect(a).toBeGreaterThan(0);
    await press("ArrowRight", { shiftKey: true });
    const [, , , , x2] = basemap(container).slice(7, -1).split(" ").map(Number) as [number, number, number, number, number, number];
    expect(x0! - x1!).toBeGreaterThan(0);
    expect(x1! - x2!).toBeGreaterThan(3 * (x0! - x1!));
    await press("ArrowDown");
    expect(header()).toContain("City 1");
    expect(basemap(container)).not.toBe(zoomed);

    // Esc is the way back, and the list moves again.
    await press("Escape");
    expect(hints(container)).toContain("[m] pan map");
    await press("ArrowDown");
    expect(header()).toContain("City 2");

    // A click on the map asks for the arrow keys; a click on the list takes them back.
    const map = container.querySelector('[data-gloom-role="world-venue-map"]') as HTMLElement;
    await act(async () => { map.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }) as unknown as Event); });
    expect(hints(container)).toContain("[Esc] list");
    const table = container.querySelector('[data-gloom-role="data-table-body-scroll"]') as HTMLElement;
    await act(async () => { table.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }) as unknown as Event); });
    expect(hints(container)).toContain("[m] pan map");
  });

  test("the keyboard zooms to the ceiling and no further", async () => {
    serve();
    const container = await mount({ layers: [], venues: true });
    await until(container, "City 0");
    let previous = "";
    for (let step = 0; step < 40 && basemap(container) !== previous; step += 1) {
      previous = basemap(container);
      await press("+", { shiftKey: true });
    }
    expect(hints(container)).not.toContain("zoom in");
    const [scale] = basemap(container).slice(7, -1).split(" ").map(Number);
    // The map is 130 - sidebar cells wide: the whole world was about a cell a degree, now a few thousand cells.
    expect(scale!).toBeGreaterThan(500);
  });
});
