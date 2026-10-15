import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { setCloudApiFetchTransport, type CloudWorldVenueMapPayload } from "../../../api-client";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { EMPTY_FOOTER, type CombinedPaneFooter } from "../../../components/layout/pane/footer/model";
import { paneFooterMenuItems } from "../../../components/layout/shell/menu";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
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
  }, {
    mic: "XLON", name: "LSE", title: "London Stock Exchange", country: "United Kingdom", countryCode: "GB",
    city: "London", timezone: "Europe/London", latitude: 51.5074, longitude: -0.1278, isOpen: false,
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

describe("the sidebar's keys in the terminal", () => {
  let footer: CombinedPaneFooter = EMPTY_FOOTER;
  function SidebarPane() {
    const id = "world-venue-map:keys";
    const [state, dispatch] = useReducer(appReducer, null, () => createInitialState(createTestPaneConfig("/tmp/world-map-keys-test", { paneId: "world-venue-map", instanceId: id, settings: { layers: [], venues: true } })));
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="market-overview" runtime={createTestPluginRuntime()} width={110} height={30} footerKeys>
        {(body, current) => {
          footer = current;
          return <WorldVenueMapPane paneId={id} paneType="world-venue-map" width={body.width} height={body.height} focused />;
        }}
      </TestPaneFrame>
    );
  }

  /** The column of the divider the sidebar draws beside its header row. */
  const divider = () => tui.frame().split("\n").find((line) => line.includes("MIC"))!.indexOf("│");
  /** The pane menu's entries with their keys, as `.` lists them. */
  const menu = () => paneFooterMenuItems(footer).flatMap((item) => (item.type === "divider" || item.type === "role" ? [] : [`${item.label} ${item.accelerator ?? ""}`.trim()]));

  test("< and > narrow and widen it, as a plain terminal reports them and as one speaking the kitty protocol does; the pane menu lists them and the footer does not", async () => {
    serve("absent");
    await act(async () => { await tui.render(<SidebarPane />, { width: 110, height: 30 }); });
    const footerRow = (await tui.waitForFrameToContain("[/]search")).trimEnd().split("\n").at(-1)!;
    expect(footerRow).not.toContain("[<]");
    expect(footerRow).not.toContain("sidebar");
    expect(menu()).toEqual(expect.arrayContaining(["Narrow Sidebar <", "Widen Sidebar >"]));
    const start = divider();
    expect(start).toBeGreaterThan(20);

    await tui.emitKeypress({ name: "<", sequence: "<" });
    await tui.renderFrames(2);
    expect(divider()).toBe(start - 4);
    // Shift+comma without the shifted character in the name, with it in the sequence.
    await tui.emitKeypress({ name: ",", shift: true, sequence: "<" });
    await tui.renderFrames(2);
    expect(divider()).toBe(start - 8);
    await tui.emitKeypress({ name: ".", shift: true, sequence: ">" });
    await tui.emitKeypress({ name: ">", sequence: ">" });
    await tui.emitKeypress({ name: ">", sequence: ">" });
    await tui.renderFrames(2);
    expect(divider()).toBe(start + 4);

    // At its widest, Widen leaves the menu and `>` does nothing; Narrow still works.
    for (let press = 0; press < 30; press += 1) await tui.emitKeypress({ name: ">", sequence: ">" });
    await tui.renderFrames(2);
    const widest = divider();
    expect(widest).toBeGreaterThan(start + 4);
    expect(menu()).not.toContain("Widen Sidebar >");
    expect(menu()).toContain("Narrow Sidebar <");
    await tui.emitKeypress({ name: ">", sequence: ">" });
    await tui.renderFrames(2);
    expect(divider()).toBe(widest);
  });
});
