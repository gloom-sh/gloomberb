/** @jsxImportSource react */
import { Window } from "happy-dom";

const testWindow = new Window({ url: "http://localhost" });
const domGlobals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  KeyboardEvent: testWindow.KeyboardEvent,
  MouseEvent: testWindow.MouseEvent,
  WheelEvent: testWindow.WheelEvent,
  HTMLElement: testWindow.HTMLElement,
  Node: testWindow.Node,
};
const priorGlobals = Object.fromEntries(
  Object.keys(domGlobals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);
Object.assign(globalThis, domGlobals);

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UiHostProvider, type RendererHost, type UiHost } from "../../../ui";
import { WebBox } from "../../../renderers/electrobun/view/host/box";
import { WebText } from "../../../renderers/electrobun/view/host/text";
import { WorldVenueMap } from "./map";
import type { CloudWorldVenuePayload } from "../../../api-client";

const renderer: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() { return ""; },
  notify() {},
};

const ui = {
  kind: "desktop-web",
  capabilities: { cellWidthPx: 8, cellHeightPx: 18, fractionalViewport: true },
  Box: WebBox,
  Text: WebText,
} as unknown as UiHost;

afterAll(() => {
  for (const [key, value] of Object.entries(priorGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});

const venue: CloudWorldVenuePayload = {
  mic: "XNYS",
  name: "NYSE",
  title: "New York Stock Exchange",
  country: "United States",
  countryCode: "US",
  city: "New York",
  timezone: "America/New_York",
  latitude: 40.7127,
  longitude: -74.006,
  isOpen: true,
};

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

test("zooms the desktop map toward the pointer on wheel", async () => {
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as unknown as Node);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <UiHostProvider ui={ui} renderer={renderer}>
        <WorldVenueMap
          venues={[venue]}
          selectedMic="XNYS"
          width={80}
          height={24}
          onSelect={() => {}}
        />
      </UiHostProvider>,
    );
  });

  const surface = container.querySelector('[data-gloom-role="world-venue-map"]') as HTMLElement;
  expect(surface).toBeTruthy();
  expect(surface.getAttribute("data-zoomed")).toBe("false");

  const wheel = new testWindow.WheelEvent("wheel", { deltaY: -180, bubbles: true, cancelable: true });
  await act(async () => {
    surface.dispatchEvent(wheel as unknown as Event);
  });

  expect(wheel.defaultPrevented).toBe(true);
  expect(surface.getAttribute("data-zoomed")).toBe("true");
});
