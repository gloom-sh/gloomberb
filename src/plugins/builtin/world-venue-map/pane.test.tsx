import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { setCloudApiFetchTransport, type CloudWorldVenueMapPayload } from "../../../api-client";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { answerGeoFixture } from "../../../test-support/test-fixture-geo";
import { WorldVenueMapPane } from "./pane";

const tui = createOpenTuiTestHarness();
afterEach(() => {
  setCloudApiFetchTransport(null);
  resetGeoCatalogCache();
});

const venues: CloudWorldVenueMapPayload = {
  checkedAt: Date.now(),
  refreshAt: Date.now() + 60_000,
  venues: [{
    mic: "XNYS", name: "NYSE", title: "New York Stock Exchange", country: "United States", countryCode: "US",
    city: "New York", timezone: "America/New_York", latitude: 40.7127, longitude: -74.006, isOpen: true,
  }],
} as CloudWorldVenueMapPayload;

function serve(geo: "absent" | "fixture") {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    const { pathname, search } = new URL(String(url));
    requests.push(pathname);
    if (pathname === "/market/venues") return Response.json({ data: venues });
    if (pathname.startsWith("/cloud/geo/")) {
      if (geo === "absent") return Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 });
      return Response.json(answerGeoFixture(pathname.slice("/cloud/geo/".length) + search));
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  return requests;
}

async function mount(settings: Record<string, unknown>) {
  const id = "world-venue-map:test";
  const state = createInitialState(createTestPaneConfig("/tmp/world-map-test", { paneId: "world-venue-map", instanceId: id, settings }));
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} paneId={id} pluginId="market-overview" runtime={createTestPluginRuntime()} width={110} height={30}>
        {(body) => <WorldVenueMapPane paneId={id} paneType="world-venue-map" width={body.width} height={body.height} focused />}
      </TestPaneFrame>,
      { width: 110, height: 30 },
    );
  });
}

describe("world map layers", () => {
  test("a server without geo layers leaves even a preset as the quiet venue map", async () => {
    const requests = serve("absent");
    await mount({ layers: ["ships"], venues: false });
    const frame = await tui.waitForFrameToContain("XNYS");
    for (let index = 0; index < 4; index += 1) await settleFrame(tui.setup());
    const settled = tui.frame();
    expect(settled).toContain("VENUE");
    expect(settled).not.toContain("Not found");
    expect(settled).not.toMatch(/layer|unavailable|Chokepoint/i);
    expect(frame).not.toContain("Loading map layers");
    expect(requests).toContain("/cloud/geo/layers");
  });

  test("a preset opens its layers with the entity table and linked tickers", async () => {
    serve("fixture");
    await mount({ layers: ["ships"], venues: false });
    const frame = await tui.waitForFrameToContain("Suez Canal");
    expect(frame).toContain("CHOKEPOINT");
    expect(frame).toContain("ZIM");
    expect(frame).not.toContain("XNYS");
  });

  test("a plain MAP opens the world map with the default layers; `MAP venues` stays the venue map", async () => {
    serve("fixture");
    await mount({});
    const plain = await tui.waitForFrameToContain("Suez Canal");
    expect(plain).toContain("CHOKEPOINT");

    await mount({ layers: [], venues: true });
    const venuesOnly = await tui.waitForFrameToContain("XNYS");
    expect(venuesOnly).toContain("VENUE");
    expect(venuesOnly).not.toContain("Suez Canal");
  });
});
