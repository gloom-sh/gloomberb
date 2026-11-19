import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildPaneSharePayload } from "../../../shares/pane";
import { materializeMarketplaceLayout, publishableMarketplaceLayout } from "../../../shares/portable-layout";
import { createTestHeadlessContext, createTestTemplateContext } from "../../../test-support/headless";
import type { PaneInstanceConfig } from "../../../types/config";
import type { GloomPluginContext } from "../../../types/plugin";
import { worldVenueMapModule } from "./index";
import { HOME_AREA_SETTING_KEY } from "./layers";

const HOME = "51.5,-0.1";
const pane = worldVenueMapModule.panes![0]!;
const template = worldVenueMapModule.paneTemplates!.find((entry) => entry.id === "world-venue-map-pane")!;
const registry = { panes: new Map([[pane.id, pane]]), paneTemplates: new Map([[template.id, template]]) };
const config = createTestHeadlessContext().config;

beforeEach(async () => {
  config.pluginConfig["market-overview"] = { [HOME_AREA_SETTING_KEY]: HOME };
  await worldVenueMapModule.setup!({ getConfig: () => config } as unknown as GloomPluginContext);
});
afterEach(() => worldVenueMapModule.dispose!());

/** The map as MAP creates it, saved in a layout. */
async function created(arg: string): Promise<PaneInstanceConfig> {
  const made = (await template.createInstance!(createTestTemplateContext({ config }), { arg }))!;
  return { instanceId: "world-venue-map:1", paneId: pane.id, title: made.title, settings: made.settings };
}

/** What leaves the device when the pane is published in a layout, and when it is shared on its own. */
function published(instance: PaneInstanceConfig) {
  const layout = publishableMarketplaceLayout(
    { dockRoot: { kind: "pane", instanceId: instance.instanceId }, instances: [instance], floating: [], detached: [] },
    {},
    registry.panes,
  );
  const shared = buildPaneSharePayload(registry, instance, {});
  return { layout, shared, text: JSON.stringify([layout, shared]) };
}

test("a map opened without a place shares no home area, in a layout or as a pane", async () => {
  const out = published(await created("ships"));
  expect(out.text).not.toContain("51.5");
  expect(out.layout.layout.instances[0]).toMatchObject({ title: "Map · Ships" });
  expect(out.layout.layout.instances[0]!.settings).not.toHaveProperty("place");
  const sharedData = out.shared?.kind === "pane" ? out.shared.data : null;
  expect(sharedData?.version === 2 && sharedData.layout.layout.instances[0]?.title).toBe("Map · Ships");
});

test("a map saved before the home area was read at render time shares without it, in its settings and title", () => {
  const legacy: PaneInstanceConfig = {
    instanceId: "world-venue-map:1",
    paneId: pane.id,
    title: `Map · Ships · ${HOME}`,
    settings: { layers: ["ships"], venues: false, place: HOME },
  };
  const out = published(legacy);
  expect(out.text).not.toContain("51.5");
  expect(out.layout.layout.instances[0]).toMatchObject({ title: "Map · Ships", settings: { layers: ["ships"], venues: false } });
  // The saved map itself keeps its place.
  expect(legacy.settings).toHaveProperty("place", HOME);
  expect(pane.portableShare!.prepare!({ ...legacy, settings: { place: ` ${HOME.toUpperCase()} ` } }, { tickers: new Map() }).settings).toEqual({});
});

test("a place that was typed is shared and opens for the receiver", async () => {
  const out = published(await created("air Sydney"));
  expect(out.layout.layout.instances[0]).toMatchObject({ title: "Map · Air · Sydney", settings: { place: "Sydney", layers: ["air"] } });
  const opened = materializeMarketplaceLayout(out.layout).layout.instances[0]!;
  expect(opened).toMatchObject({ title: "Map · Air · Sydney", settings: { place: "Sydney" } });
  expect(out.text).not.toContain("51.5");
});
