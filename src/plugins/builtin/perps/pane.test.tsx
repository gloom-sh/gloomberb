import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { perpsCache, perpsHistoryCache, perpsMarketCache } from "./client";
import { PerpsPane } from "./pane";
import { perpBoard, perpHistory } from "./test-fixture";
const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); perpsCache.reset(); perpsHistoryCache.reset(); perpsMarketCache.reset(); });
async function mount(tab = "history") {
  const id = "perps:test";
  const state = createInitialState(createTestPaneConfig("/tmp/perps-pane-test", { paneId: "perps", instanceId: id, settings: { tab } }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="market-overview" runtime={createTestPluginRuntime()}>
      <PaneFooterProvider>{(footer) => <Box width={110} height={25} flexDirection="column"><Box height={24}><PerpsPane width={110} height={24} focused /></Box><PaneFooterBar footer={footer} width={110} focused /><PaneFooterKeys paneId={id} footer={footer} focused /></Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 110, height: 25 }); });
}
test("preview retains latest market values while its history is locked", async () => {
  const calls: string[] = [];
  const board = perpBoard({ locked: 5, access: "preview" });
  setCloudApiFetchTransport(async (url) => {
    calls.push(String(url));
    return Response.json(String(url).includes("/history") ? perpHistory({ locked: true, access: "preview" }) : { ...board, evidence: [], methodologyUrl: "https://gloom.sh/docs/perpetuals" });
  });
  await mount();
  const frame = await tui.waitForFrameToContain("Full history requires Gloom Pro.");
  expect(frame).toContain("Funding / 8h");
  expect(frame).toContain("Open interest USD");
  expect(frame).toContain("Upgrade for full history");
  expect(frame).not.toContain("Rankings");
  expect(frame).not.toContain("Compare");
  expect(frame).not.toContain("NaN");
  expect(calls.some((url) => url.includes("marketId=hyperliquid%3Adefault%3ABTC"))).toBe(true);
});
test("evidence distinguishes source time, raw interval, reference price and retained revision", async () => {
  const board = perpBoard();
  setCloudApiFetchTransport(async (url) => Response.json(String(url).includes("/market?") ? { ...board, evidence: [{ kind: "funding", period_at: board.asOf, received_at: board.asOf, superseded_at: null, fingerprint: "revision-one", payload: {} }], methodologyUrl: "https://gloom.sh/docs/perpetuals" } : board));
  await mount("evidence");
  const frame = await tui.waitForFrameToContain("Funding 8h / APR");
  expect(frame).toContain("Underlying last");
  expect(frame).toContain("Unavailable");
  expect(frame).toContain("Source as of");
});
