/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { WorldVenueMap } from "./map";
import type { CloudWorldVenuePayload } from "../../../api-client";
import type { GeoFeature } from "../../../api-client/geo";
import type { GeoMapOverlay } from "./geo-draw";
import type { WorldMapFocus } from "./map";
import type { WorldMapViewport } from "./model";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";

const { window: testWindow, render: renderDom } = createDomTestHarness();

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

test("zooms the desktop map toward the pointer on wheel", async () => {
  const container = await renderDom(
    <WorldVenueMap
      venues={[venue]}
      selectedMic="XNYS"
      width={80}
      height={24}
      onSelect={() => {}}
    />,
  );

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

test("a dense layer draws dots until zooming leaves few enough in view for icons, even a layer the app does not know", async () => {
  const features: GeoFeature[] = Array.from({ length: 1200 }, (_, index) => ({
    id: `station:${index}`,
    layer: "weather-stations",
    entityKind: "station",
    label: `Station ${index}`,
    geometry: { type: "Point", coordinates: [-170 + (index % 40) * 8.5, -50 + Math.floor(index / 40) * 4.3] },
    ts: null,
    props: {},
  }));
  const overlay: GeoMapOverlay = {
    layers: [{ id: "weather-stations", name: "Weather stations", geometry: "point", color: "#4dabf7", features, clusters: [] }],
    selected: null,
    trail: null,
  };
  const container = await renderDom(<WorldVenueMap venues={[]} selectedMic={null} width={80} height={24} onSelect={() => {}} overlay={overlay} maxZoom={64} />);
  const style = () => container.querySelector("[data-geo-style]")?.getAttribute("data-geo-style");
  expect(style()).toBe("dots");

  const surface = container.querySelector('[data-gloom-role="world-venue-map"]') as HTMLElement;
  for (let step = 0; step < 4; step += 1) {
    await act(async () => {
      surface.dispatchEvent(new testWindow.WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true }) as unknown as Event);
    });
  }
  expect(style()).toBe("icons");
  // Only the features in view were counted, and each draws the fallback dot icon.
  expect(container.querySelectorAll('[data-geo-style="icons"] > path').length).toBe(1200);
});

/** Where the basemap puts a longitude and latitude, in view units. */
function placed(container: HTMLElement, longitude: number, latitude: number): { x: number; y: number } {
  const transform = container.querySelector('[data-gloom-role="basemap"]')!.getAttribute("transform")!;
  const [a, , , , bx, by] = transform.slice("matrix(".length, -1).split(" ").map(Number);
  return { x: a! * longitude + bx!, y: by! - a! * latitude };
}

// GLO-355: a pane that is docked, undocked or popped out mounts a new map.
// It reopened on the whole world while the ship's detail stayed open.
test("a map mounted again for the same pane reopens where the last one rested", async () => {
  let saved: WorldMapViewport | null = null;
  const first = await renderDom(
    <WorldVenueMap venues={[venue]} selectedMic={null} width={80} height={24} onSelect={() => {}} maxZoom={64} onViewportSettled={(viewport) => { saved = viewport; }} />,
  );
  const surface = first.querySelector('[data-gloom-role="world-venue-map"]') as HTMLElement;
  for (let step = 0; step < 3; step += 1) {
    await act(async () => {
      surface.dispatchEvent(new testWindow.WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true }) as unknown as Event);
    });
  }
  await act(async () => { await Bun.sleep(450); });
  expect(saved).not.toBeNull();
  const before = first.querySelector('[data-gloom-role="basemap"]')!.getAttribute("transform");

  const second = await renderDom(
    <WorldVenueMap venues={[venue]} selectedMic={null} width={80} height={24} onSelect={() => {}} maxZoom={64} savedViewport={saved} />,
  );
  expect(second.querySelector('[data-gloom-role="world-venue-map"]')!.getAttribute("data-zoomed")).toBe("true");
  expect(second.querySelector('[data-gloom-role="basemap"]')!.getAttribute("transform")).toBe(before);
});

test("a map that first lays out with no width still centres on the entity it was asked to show", async () => {
  let resize: (width: number) => void = () => {};
  const focus: WorldMapFocus = { key: "open:vessels:mmsi:319032700", longitude: 54.4, latitude: 24.5, zoom: 64 };
  function Pane() {
    const [width, setWidth] = useState(1);
    resize = setWidth;
    return <WorldVenueMap venues={[]} selectedMic={null} width={width} height={24} onSelect={() => {}} maxZoom={64} focus={focus} />;
  }
  const container = await renderDom(<Pane />);
  // Nothing is drawn from a plot without area.
  expect(container.querySelector("svg")).toBeNull();
  await act(async () => resize(80));
  const at = placed(container, focus.longitude, focus.latitude);
  expect(at.x).toBeCloseTo((80 - 1) / 2, 3);
  expect(container.querySelector('[data-gloom-role="world-venue-map"]')!.getAttribute("data-zoomed")).toBe("true");
});
