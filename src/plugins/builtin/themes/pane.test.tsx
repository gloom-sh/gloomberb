import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import { THEME_PERIODS, type ThemeSummary } from "../../../api-client/themes";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { sectorsModule } from "../sectors";
import { membersCache, themesCache } from "./client";

// THEM is the Themes tab of the Sector Performance pane.
const SectorPane = sectorsModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); membersCache.reset(); themesCache.reset(); });
const theme: ThemeSummary = { id: "nuclear", name: "Nuclear & uranium", description: "", keywords: ["reactors"], memberCount: 1, present: 1, stale: true,
  returns: Object.fromEntries(THEME_PERIODS.map((field) => [field, { value: 2, covered: 1, total: 1 }])) as ThemeSummary["returns"],
  breadth: { value: 100, covered: 1, total: 1 }, best: { symbol: "CCJ", changePercent: 2 }, worst: { symbol: "CCJ", changePercent: 2 } };

test("THEM with a theme opens its members under the tab strip, Escape persists the list instead of restoring the argument, and Enter opens the listing", async () => {
  themesCache.attach(new MemoryPluginPersistence());
  membersCache.attach(new MemoryPluginPersistence());
  const metadata = { asOf: new Date().toISOString(), snapshotId: "test", stale: true };
  setCloudApiFetchTransport(async (url) => Response.json(String(url).endsWith("/nuclear")
    ? { ...metadata, theme, members: [{ symbol: "CCJ", name: "Cameco", exchange: "NYSE", present: true, price: 100,
      ...Object.fromEntries(THEME_PERIODS.map((field) => [field, 2])), asOf: {}, stale: false }] }
    : { ...metadata, themes: [theme] }));
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: "themes", paneId: "sectors", params: { theme: "reactors" } }));
  const opened: string[] = [];
  const runtime = createTestPluginRuntime({ navigateTicker: (symbol) => { opened.push(symbol); } });
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((current) => appReducer(current, action));
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="themes" pluginId="market-overview" runtime={runtime} width={90} height={20}>
      {(body) => <SectorPane paneId="themes" paneType="sectors" focused {...body} />}
    </TestPaneFrame>;
  }
  await tui.render(<Harness />, { width: 90, height: 20 });
  await tui.waitForFrameToContain("Cameco");
  expect(tui.frame()).toContain("Sectors  Industries  Themes");
  expect(tui.frame()).not.toContain("stale");
  await act(async () => tui.setup().mockInput.pressEscape());
  await tui.waitForFrameToContain("BREADTH");
  expect(tui.frame()).not.toContain("← Back");
  expect(tui.frame()).not.toContain("stale");
  await act(async () => tui.setup().mockInput.pressEnter());
  await tui.waitForFrameToContain("Cameco");
  await act(async () => tui.setup().mockInput.pressEnter());
  expect(opened).toEqual(["CCJ:NYSE"]);
});

test("historical stale flags do not warn for a fresh board, but an old snapshot or failed refresh does", async () => {
  themesCache.attach(new MemoryPluginPersistence());
  let asOf = new Date().toISOString(), fail = false;
  setCloudApiFetchTransport(async () => fail ? new Response("Service unavailable", { status: 503 })
    : Response.json({ asOf, snapshotId: "test", stale: true, themes: [theme] }));
  const state = createInitialState(createTestPaneConfig(":memory:", { instanceId: "themes", paneId: "sectors", params: { theme: "" } }));
  await tui.render(<TestPaneFrame state={state} paneId="themes" pluginId="market-overview" runtime={createTestPluginRuntime()} width={90} height={20}>
    {(body) => <SectorPane paneId="themes" paneType="sectors" focused {...body} />}
  </TestPaneFrame>, { width: 90, height: 20 });
  await tui.waitForFrameToContain("snapshot");
  expect(tui.frame()).not.toContain("stale");

  asOf = new Date(Date.now() - 31 * 60_000).toISOString();
  await tui.emitKeypress({ name: "r", sequence: "r" });
  await tui.waitForFrameToContain("stale");
  asOf = new Date().toISOString();
  await tui.emitKeypress({ name: "r", sequence: "r" });
  await tui.waitForFrameToExclude("stale");
  fail = true;
  await tui.emitKeypress({ name: "r", sequence: "r" });
  await tui.waitForFrameToContain("stale");
  expect(tui.frame()).toContain("Nuclear & uranium");
});
