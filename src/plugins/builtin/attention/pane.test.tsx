import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { AttentionPayload } from "../../../api-client/attention";
import { attentionCache } from "./client";
import { AttentionPane } from "./pane";
import { attentionFixture, attentionPreview } from "./test-fixture";
import { altDataPlugin } from "../composite-plugins";
const tui = createOpenTuiTestHarness();
afterEach(() => { apiClient.setSessionToken(null); setCloudApiFetchTransport(null); attentionCache.reset(); });
async function mount(data: AttentionPayload, settings: Record<string, unknown> = {}, respond?: (url: string) => AttentionPayload) {
  attentionCache.attach(new MemoryPluginPersistence());
  apiClient.setSessionToken("isolated-attention-test");
  apiClient.restoreCachedUser({ id: "isolated-test", name: "Test", emailVerified: true, plan: data.entitlement === "pro" ? "pro" : "free" });
  setCloudApiFetchTransport(async (url) => {
    const path = new URL(String(url)).pathname;
    const symbol = path.includes("/attention/") ? decodeURIComponent(path.split("/attention/")[1]!) : null;
    return Response.json(respond ? respond(String(url)) : symbol ? { ...data, rows: data.rows.filter((row) => row.symbol === symbol || row.ticker === symbol) } : data);
  });
  const id = "attention:test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-attention-test", { paneId: "attention", instanceId: id, binding: { kind: "none" }, settings }));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={id} pluginId="market-overview" runtime={createTestPluginRuntime()} width={90} height={23} footerKeys>
      {(body) => <AttentionPane paneId={id} paneType="attention" {...body} focused />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 23 }); });
}
test("a bare ticker opens canonical history, with current values and independent market dates", async () => {
  const data = attentionFixture();
  data.rows = [{ ...data.rows[1]!, symbol: "NVDA:NASDAQ", history: data.rows[1]!.history.slice(-42) }];
  await mount(data, { symbol: "NVDA", tab: "history" });
  const frame = await tui.waitForFrameToContain("NVDA:NASDAQ research hours");
  expect(frame).toContain("285");
  await tui.emitKeypress({ name: "e" });
  const evidence = await tui.waitForFrameToContain("Relative volume");
  expect(evidence).toContain("2026-10-02 14:00 UTC");
  expect(evidence).toContain("2026-10-02 15:00 UTC");
});
test("qualified historical hours remain reachable when every current ticker is suppressed", async () => {
  const full = attentionFixture();
  const prior = { ...full.rows[0]!, history: full.rows[0]!.history.slice(-42) };
  const empty = attentionFixture({ rows: [], countries: [], sectors: [], status: "collecting", counts: { rows: 0, sectors: 0, countries: 0 } });
  const detail = { ...empty, selectedListing: prior, history: prior.history, historyEvidence: prior.evidence };
  await mount(empty, { symbol: prior.symbol, tab: "history" }, (url) => new URL(url).pathname.endsWith("/attention") ? empty : detail);
  const frame = await tui.waitForFrameToContain("6758:JPX research hours");
  expect(frame).not.toContain("Waiting for privacy-qualified research activity.");
  expect(frame).toContain("2026-10-02 17:00");
});
test("preview displays retained rows and makes history gating explicit", async () => {
  await mount(attentionPreview());
  const frame = await tui.waitForFrameToContain("Sony Group");
  expect(frame).not.toContain("Taiwan Semiconductor");
  await tui.emitKeypress({ name: "return" });
  const history = await tui.waitForFrameToContain("Pro unlocks published history.");
  expect(history).toContain("2026-10-02 17:00");
});

test("group selection opens its exact country and does not expose unrelated ticker actions", async () => {
  const data = attentionFixture();
  data.rows[3]!.name = "ASUS fixture";
  await mount(data, { tab: "countries" });
  const frame = await tui.waitForFrameToContain("GROUP");
  expect(frame).not.toContain("[d]es");
  await tui.emitKeypress({ name: "j" });
  await tui.emitKeypress({ name: "return" });
  const ranking = await tui.waitForFrameToContain("NVIDIA");
  expect(ranking).not.toContain("ASUS fixture");
  expect(ranking).not.toContain("Sony Group");
});

// Alt Data's own namespace is Ticker Research's, for the modules it takes
// over from there; the attention pane keeps the one it saved under in Market
// Overview.
test("inside Alt Data, opens on the tab it saved under Market Overview", async () => {
  const data = attentionFixture();
  attentionCache.attach(new MemoryPluginPersistence());
  apiClient.setSessionToken("isolated-attention-test");
  apiClient.restoreCachedUser({ id: "isolated-test", name: "Test", emailVerified: true, plan: "pro" });
  setCloudApiFetchTransport(async () => Response.json(data));
  const id = "attention:saved";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-attention-test", { paneId: "attention", instanceId: id, binding: { kind: "none" } }));
  state.paneState[id] = { pluginState: { "market-overview": { "attention:tab": "countries" } } };
  const AltDataAttentionPane = altDataPlugin.panes!.find((pane) => pane.id === "attention")!.component;
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={90} height={23}>
        {(body) => <AltDataAttentionPane paneId={id} paneType="attention" {...body} focused />}
      </TestPaneFrame>,
      { width: 90, height: 23 },
    );
  });
  const frame = await tui.waitForFrameToContain("GROUP");
  expect(frame).not.toContain("NVIDIA");
});
