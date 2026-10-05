import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import { THEME_PERIODS, type ThemeSummary } from "../../../api-client/themes";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { membersCache, themesCache } from "./client";
import { ThemesPane } from "./pane";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); membersCache.reset(); themesCache.reset(); });

test("a command argument opens members, Escape persists the list instead of restoring the argument, and Enter opens the listing", async () => {
  themesCache.attach(new MemoryPluginPersistence());
  membersCache.attach(new MemoryPluginPersistence());
  const theme: ThemeSummary = { id: "nuclear", name: "Nuclear & uranium", description: "", keywords: ["reactors"], memberCount: 1, present: 1, stale: false,
    returns: Object.fromEntries(THEME_PERIODS.map((field) => [field, { value: 2, covered: 1, total: 1 }])) as ThemeSummary["returns"],
    breadth: { value: 100, covered: 1, total: 1 }, best: { symbol: "CCJ", changePercent: 2 }, worst: { symbol: "CCJ", changePercent: 2 } };
  const metadata = { asOf: new Date().toISOString(), snapshotId: "test", stale: false };
  setCloudApiFetchTransport(async (url) => Response.json(String(url).endsWith("/nuclear")
    ? { ...metadata, theme, members: [{ symbol: "CCJ", name: "Cameco", exchange: "NYSE", present: true, price: 100,
      ...Object.fromEntries(THEME_PERIODS.map((field) => [field, 2])), asOf: {}, stale: false }] }
    : { ...metadata, themes: [theme] }));
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: "themes", paneId: "themes", params: { theme: "reactors" } }));
  const opened: string[] = [];
  const runtime = createTestPluginRuntime({ navigateTicker: (symbol) => { opened.push(symbol); } });
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((current) => appReducer(current, action));
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="themes" pluginId="market-overview" runtime={runtime} width={90} height={20}>
      {(body) => <ThemesPane paneId="themes" paneType="themes" focused {...body} />}
    </TestPaneFrame>;
  }
  await tui.render(<Harness />, { width: 90, height: 20 });
  await tui.waitForFrameToContain("Cameco");
  await act(async () => tui.setup().mockInput.pressEscape());
  await tui.waitForFrameToContain("BREADTH");
  expect(tui.frame()).not.toContain("← Back");
  await act(async () => tui.setup().mockInput.pressEnter());
  await tui.waitForFrameToContain("Cameco");
  await act(async () => tui.setup().mockInput.pressEnter());
  expect(opened).toEqual(["CCJ:NYSE"]);
});
