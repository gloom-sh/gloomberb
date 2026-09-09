/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { WorldVenueMap } from "./map";
import type { CloudWorldVenuePayload } from "../../../api-client";
import { createDomTestHarness } from "../../../renderers/electrobun/view/test-utils";

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
