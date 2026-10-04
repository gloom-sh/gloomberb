import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { attentionCache } from "./client";
import { HiringPane } from "./pane";
import { AppRankView } from "./app-rank";
import realHiring from "./fixtures/hiring.json";
import realAppRank from "./fixtures/app-rank.json";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); attentionCache.reset(); });
async function mount(tab: string, onNavigate: (id: string, symbol?: string | null) => void) {
  const id = "hiring:test";
  const state = createInitialState(createTestPaneConfig("/tmp/hiring-pane-test", { paneId: "hiring", instanceId: id, binding: { kind: "fixed", symbol: "ADYEN:AMS" }, settings: { tab, attentionSnapshot: realHiring } }));
  state.tickers.set("ADYEN:AMS", createTestTicker("ADYEN:AMS", "Adyen"));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime({ createPaneFromTemplate: (template, options) => onNavigate(template, options?.symbol) })}>
      <PaneFooterProvider>{(footer) => <Box width={100} height={22} flexDirection="column"><Box height={21}><HiringPane width={100} height={21} focused /></Box><PaneFooterBar footer={footer} width={100} focused /><PaneFooterKeys paneId={id} footer={footer} focused /></Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 22 }); });
}
test("evidence opens in the stack, keeps original title, and DES preserves the non-US exchange", async () => {
  const navigations: Array<[string, string | null | undefined]> = [];
  await mount("evidence", (id, symbol) => navigations.push([id, symbol]));
  await tui.waitForFrameToContain("SENIORITY");
  await tui.emitKeypress({ name: "return" });
  const frame = await tui.waitForFrameToContain("Reporting ticker");
  expect(frame).toContain("ADYEN:AMS");
  expect(frame).toContain("Revision");
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("SENIORITY");
  await tui.emitKeypress({ name: "d" });
  expect(navigations).toEqual([["new-ticker-detail-pane", "ADYEN:AMS"]]);
});

test("individual app history opens with the requested window", async () => {
  const id = "apps:window:test";
  const state = createInitialState(createTestPaneConfig("/tmp/apps-window-test", { paneId: "apps", instanceId: id, settings: { days: "365", appRankSnapshot: realAppRank } }));
  const focus = { store: "app-store" as const, appId: "6446901002", name: "Threads", country: "US", chart: "free" as const };
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <AppRankView focus={focus} accessKey="window-test" width={100} height={22} focused />
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 22 }); });
  expect(await tui.waitForFrameToContain("365D")).toContain("US");
});
