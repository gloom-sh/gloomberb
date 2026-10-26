import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { SeriesCatalogEntry } from "../../../series/types";
import { SERIES_CATALOG_CAPABILITY_ID } from "../../../series/capability";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { createStaticAppStore } from "../../../test-support/app-store";
import { Text } from "../../../ui";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { useSeriesCatalogSuggestions, type SeriesCatalogSearchResult } from "./use-series-catalog";
import { ChartSeriesQuickAdd } from "./quick-add";
import { SeriesEditorDialog } from "./editor";
import { buildPriceChartPreset } from "./presets";

const tui = createOpenTuiTestHarness({ width: 100, height: 42 });
afterEach(() => setSharedRegistryForTests(undefined));
const local: SeriesCatalogEntry = { id: "fixture:local", name: "Local", unit: "index", frequency: "monthly", expression: "FRED:CPIAUCSL", pluginId: "fixture" };
const remote: SeriesCatalogEntry = { ...local, id: "fixture:remote", name: "Remote", expression: "FRED:UNRATE" };

function fixture(mapFailure = false) {
  const source = { failed: true, malformed: false, entries: [remote], calls: 0 };
  setSharedRegistryForTests({
    usesRemoteCapabilities: true,
    marketData: createTestDataProvider(),
    capabilityManifests: () => mapFailure ? [{ id: "maps.series", kind: "chart-series", name: "Map", operations: [] }] : [],
    getTicker: () => null,
    series: { subscribe: () => () => {}, getVersion: () => 0, catalog: () => [local], findByExpression: () => null },
    invokeCapability: async (id: string) => {
      if (id === "maps.series") throw new Error("private map payload");
      expect(id).toBe(SERIES_CATALOG_CAPABILITY_ID);
      source.calls++;
      if (source.failed) throw new Error("private remote payload");
      return source.malformed ? {} : { entries: source.entries };
    },
  } as unknown as PluginRegistry);
  return source;
}

test("remote catalog failure keeps available entries, retries, and keeps the last remote entries through a failed refresh", async () => {
  const source = fixture();
  let latest!: SeriesCatalogSearchResult;
  function Search() {
    latest = useSeriesCatalogSuggestions({ query: "fixture", defaultInstrument: { symbol: "AAPL" }, enabled: true });
    return <Text>{[latest.error ?? "No failure", ...latest.suggestions.map((entry) => entry.label)].join(" | ")}</Text>;
  }
  await tui.render(<Search />);
  let frame = await tui.waitForFrameToContain("Series catalog unavailable.");
  expect(frame).toContain("Local");
  expect(frame).not.toContain("private remote");
  expect(source.calls).toBe(1);
  source.failed = false;
  await act(async () => { await latest.retry(); });
  await tui.waitForFrameToContain("Remote");
  expect(latest.error).toBeNull();
  source.malformed = true;
  await act(async () => { await latest.retry(); });
  frame = await tui.waitForFrameToContain("Series catalog unavailable.");
  expect(frame).toContain("Local");
  expect(frame).toContain("Remote");
  source.malformed = false;
  source.entries = [];
  await act(async () => { await latest.retry(); });
  await tui.waitForFrameToExclude("Remote");
  expect(latest.error).toBeNull();
  expect(latest.suggestions.some((entry) => entry.label.includes("Local"))).toBe(true);
});

test("the inline picker keeps available choices beside a failure and its keyboard retry never adds a series", async () => {
  const source = fixture();
  let adds = 0;
  const store = createStaticAppStore(createInitialState(createDefaultConfig("/tmp/gloom-remote-catalog")));
  await tui.render(<AppContext value={store}><ChartSeriesQuickAdd spec={buildPriceChartPreset("AAPL")} setSpec={() => { adds++; }} focused width={100} height={16} shortcutEnabled shortcutBlocked={false} onActivatePane={() => {}} /></AppContext>);
  await tui.emitKeypress({ name: "n", sequence: "n" });
  await act(async () => { await tui.setup().mockInput.typeText("fixture"); });
  // The failure shows from the moment the picker opens, before the query is typed: wait for the suggestions of
  // the typed query, or a frame painted before it would be read as the one that has them.
  const frame = await tui.waitForFrameToContain("Local");
  expect(frame).toContain("Series catalog unavailable.");
  expect(frame).toContain("Retry");
  source.failed = false;
  await tui.emitKeypress({ name: "up", sequence: "\u001b[A" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "return", sequence: "\r" }, { trackPropagation: true });
  await tui.waitForFrameToContain("Remote");
  expect(tui.frame()).not.toContain("Series catalog unavailable.");
  expect(source.calls).toBe(2);
  expect(adds).toBe(0);
});

test("the editor keeps local suggestions visible and retries a failed remote catalog with its shared Retry button", async () => {
  const source = fixture();
  await tui.render(<SeriesEditorDialog dialogId="remote-catalog" initialSpec={buildPriceChartPreset("AAPL")} dismiss={() => {}} resolve={() => {}} />);
  await act(async () => { await tui.setup().mockInput.typeText("fixture"); });
  const frame = await tui.waitForFrameToContain("Series catalog unavailable.");
  expect(frame).toContain("Local");
  source.failed = false;
  await tui.waitForFrameToContain(" Retry ");
  await tui.clickFrameText("Retry");
  expect(source.calls).toBe(2);
  await tui.waitForFrameToContain("Remote");
  expect(tui.frame()).not.toContain("Series catalog unavailable.");
  expect(source.calls).toBe(2);
});


test("a simultaneous map lookup failure cannot hide the remote failure or available entries", async () => {
  fixture(true);
  function Search() {
    const result = useSeriesCatalogSuggestions({ query: "fixture", defaultInstrument: { symbol: "AAPL" }, enabled: true });
    return <Text>{[result.error, ...result.suggestions.map((entry) => entry.label)].join(" | ")}</Text>;
  }
  await tui.render(<Search />);
  const frame = await tui.waitForFrameToContain("Map search unavailable.");
  expect(frame).toContain("Series catalog unavailable.");
  expect(frame).toContain("Local");
  expect(frame).not.toContain("private");
});
