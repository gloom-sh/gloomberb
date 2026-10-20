import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { attentionCache } from "./client";
import { attentionFixture } from "./test-fixture";
import { TrendingSummary } from "./trending";

const tui = createOpenTuiTestHarness();
afterEach(() => { apiClient.setSessionToken(null); setCloudApiFetchTransport(null); attentionCache.reset(); });

// GLO-1102: an Overview section with nothing but a waiting or empty line is noise; DES leaves it out.
test("the Overview's Gloom Trending shows only a symbol's published research hours", async () => {
  attentionCache.attach(new MemoryPluginPersistence());
  apiClient.setSessionToken("isolated-attention-test");
  apiClient.restoreCachedUser({ id: "isolated-test", name: "Test", emailVerified: true, plan: "pro" });
  const data = attentionFixture({ window: "today" });
  const requested: string[] = [];
  setCloudApiFetchTransport(async (url) => {
    const symbol = decodeURIComponent(new URL(String(url)).pathname.split("/attention/")[1] ?? "");
    requested.push(symbol);
    return Response.json({ ...data, rows: data.rows.filter((row) => row.symbol === symbol), status: symbol === "NVDA" ? "ready" : "collecting" });
  });
  const id = "ticker-research:test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-trending-test", { paneId: "ticker-research", instanceId: id, binding: { kind: "none" } }));
  function Summary({ symbol }: { symbol: string }) {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={80} height={10}>
      {() => <TrendingSummary symbol={symbol} onOpen={() => {}} />}
    </TestPaneFrame>;
  }
  const summary = (symbol: string) => <Summary key={symbol} symbol={symbol} />;
  await act(async () => { await tui.render(summary("NVDA"), { width: 80, height: 10 }); });
  expect(await tui.waitForFrameToContain("Research rank")).toContain("Open research attention");

  await act(async () => { await tui.render(summary("QUIET"), { width: 80, height: 10 }); });
  for (let i = 0; i < 50 && !requested.includes("QUIET"); i++) await act(async () => { await Bun.sleep(10); });
  await act(async () => { await Bun.sleep(30); });
  expect(requested).toContain("QUIET");
  const quiet = tui.frame();
  expect(quiet).not.toContain("Gloom Trending");
  expect(quiet).not.toContain("research attention");
});
