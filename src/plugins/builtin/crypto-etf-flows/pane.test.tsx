import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useMemo, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CryptoEtfFlowAsset, CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cryptoEtfFlowsCache } from "./client";
import { CryptoEtfFlowsPane } from "./pane";

const tui = createOpenTuiTestHarness({ width: 120, height: 30 });
afterEach(() => cryptoEtfFlowsCache.reset());

function payload(asset: CryptoEtfFlowAsset, empty = false): CryptoEtfFlowsPayload {
  const ticker = asset === "BTC" ? "IBIT" : "ETHA";
  return {
    asset, unit: "USD millions", funds: [{ ticker, name: null, issuer: null }],
    days: empty ? [] : [{ date: "2026-10-20", flows: { [ticker]: 123 }, total: 123, pending: [] }],
    asOf: "2026-10-20", fetchedAt: "2026-10-21T02:00:00Z", stale: false,
    source: { publisher: "Farside Investors", url: "https://farside.co.uk/" },
  };
}

function Harness() {
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const state = createInitialState(createTestPaneConfig("/unused-etff-test", { instanceId: "etff", paneId: "crypto-etf-flows" }));
    state.focusedPaneId = "etff";
    return state;
  });
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return <TestPaneFrame state={state} dispatch={dispatch} paneId="etff" pluginId="crypto" runtime={runtime} width={120} height={30}>
    {(body) => <CryptoEtfFlowsPane paneId="etff" paneType="crypto-etf-flows" focused {...body} />}
  </TestPaneFrame>;
}

test("asset controls survive loading, 503 and empty; r retries, stale rows stay visible and switches reuse cached rows", async () => {
  let mode: "error" | "empty" | "stale" = "error";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const calls: CryptoEtfFlowAsset[] = [];
  const stub = spyOn(apiClient, "getCloudCryptoEtfFlows").mockImplementation(async (asset) => {
    calls.push(asset);
    if (asset === "BTC") return payload(asset);
    await pending;
    if (mode === "error") throw new ApiRequestError("flows_unavailable", 503);
    return { ...payload(asset, mode === "empty"), stale: mode === "stale" };
  });
  try {
    await tui.render(<Harness />);
    await tui.waitForFrameToContain("IBIT");
    await tui.clickFrameText("Ether");
    const loading = await tui.waitForFrameToContain("Loading");
    expect(loading).toContain("Bitcoin");
    expect(loading).not.toContain("IBIT");
    await act(async () => release());
    const failed = await tui.waitForFrameToContain("not available yet");
    expect(failed).toContain("Bitcoin");
    expect(failed).toContain("1M");

    await tui.clickFrameText("Bitcoin");
    const restored = await tui.waitForFrameToContain("IBIT");
    expect(restored).not.toContain("Loading bitcoin");
    expect(calls.filter((asset) => asset === "BTC")).toHaveLength(1);
    await tui.clickFrameText("Ether");
    await tui.waitForFrameToContain("not available yet");
    mode = "empty";
    const reads = calls.length;
    await tui.emitKeypress({ name: "r", sequence: "r" });
    const empty = await tui.waitForFrameToContain("No ether ETF flows listed yet");
    expect(calls.length).toBe(reads + 1);
    expect(empty).toContain("Bitcoin");

    mode = "stale";
    await tui.emitKeypress({ name: "r", sequence: "r" });
    const stale = await tui.waitForFrameToContain("stale");
    expect(stale).toContain("ETHA");
    expect(stale).toContain("123.0");
    await tui.clickFrameText("Bitcoin");
    await tui.waitForFrameToContain("IBIT");
    expect(tui.frame()).not.toContain("ETHA");
  } finally {
    await tui.destroy();
    stub.mockRestore();
  }
});
