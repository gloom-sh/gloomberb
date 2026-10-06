import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import { THEME_PERIODS, type ThemeSummary } from "../../../api-client/themes";
import { normalizeLoadedConfig } from "../../../data/config/store/normalize";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { CURRENT_CONFIG_VERSION } from "../../../types/config";
import { membersCache, themesCache } from "../themes/client";
import { sectorsModule } from "./index";

const Pane = sectorsModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
const theme: ThemeSummary = { id: "nuclear", name: "Nuclear & uranium", description: "", keywords: [], memberCount: 1, present: 1, stale: false,
  returns: Object.fromEntries(THEME_PERIODS.map((field) => [field, { value: 2, covered: 1, total: 1 }])) as ThemeSummary["returns"],
  breadth: { value: 100, covered: 1, total: 1 }, best: null, worst: null };

afterEach(() => { setCloudApiFetchTransport(null); membersCache.reset(); themesCache.reset(); });

function serveThemes() {
  themesCache.attach(new MemoryPluginPersistence());
  membersCache.attach(new MemoryPluginPersistence());
  const metadata = { asOf: new Date().toISOString(), snapshotId: "test", stale: false };
  setCloudApiFetchTransport(async (url) => Response.json(String(url).endsWith("/nuclear")
    ? { ...metadata, theme, members: [{ symbol: "CCJ", name: "Cameco", exchange: "NYSE", present: true, price: 100,
      ...Object.fromEntries(THEME_PERIODS.map((field) => [field, 2])), asOf: {}, stale: false }] }
    : { ...metadata, themes: [theme] }));
}

async function renderPane(state: AppState, instanceId: string) {
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={instanceId} pluginId="market-overview" runtime={createTestPluginRuntime()} width={90} height={20}>
      {(body) => <Pane paneId={instanceId} paneType="sectors" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 20 }); });
}

test("BI opens on Sectors, and Themes is the third tab beside the ETF collections", async () => {
  serveThemes();
  const config = createTestPaneConfig(":memory:", { instanceId: "sectors:main", paneId: "sectors" });
  config.refreshIntervalMinutes = 0;
  await renderPane(createInitialState(config), "sectors:main");
  await tui.waitForFrameToContain("XLK");
  expect(tui.frame()).toContain("Sectors  Industries  Themes");

  await tui.emitKeypress([{ name: "l", sequence: "l" }, { name: "l", sequence: "l" }]);
  await tui.waitForFrameToContain("Nuclear & uranium");
  expect(tui.frame()).toContain("BREADTH");
  expect(tui.frame()).not.toContain("XLK");

  await tui.emitKeypress({ name: "h", sequence: "h" });
  await tui.waitForFrameToContain("SMH");
  expect(tui.frame()).not.toContain("Nuclear & uranium");
});

test("a saved layout with the old Thematic Baskets pane opens the Themes tab where it left off", async () => {
  serveThemes();
  const layout = { dockRoot: { kind: "pane", instanceId: "themes:saved" }, floating: [], detached: [],
    instances: [{ instanceId: "themes:saved", paneId: "themes", binding: { kind: "none" }, params: { theme: "" } }] };
  const { config } = normalizeLoadedConfig({
    configVersion: CURRENT_CONFIG_VERSION, onboardingComplete: true, layout, activeLayoutIndex: 0,
    layouts: [{ name: "Default", layout, paneState: { "themes:saved": { pluginState: { "market-overview": { openTheme: "nuclear" } } } } }],
  }, ":memory:");
  expect(config.layout.instances.map((instance) => instance.paneId)).toEqual(["sectors"]);

  await renderPane(createInitialState(config), "themes:saved");
  await tui.waitForFrameToContain("Cameco");
  expect(tui.frame()).toContain("Sectors  Industries  Themes");
  expect(tui.frame()).toContain("Nuclear & uranium");
});
