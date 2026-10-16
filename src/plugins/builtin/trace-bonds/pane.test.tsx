import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { TRACE_BONDS_PANE_ID } from "./model";
import { TraceBondsPane } from "./pane";

const tui = createOpenTuiTestHarness();
afterEach(async () => {
  setHttpFetchTransport(null);
  await tui.destroy();
});

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
}

/** Whirlpool answers; any other issuer's requests fail. */
function tape() {
  setHttpFetchTransport(async (_url, init) => {
    if (!init?.method) return new Response("", { headers: { "set-cookie": "XSRF-TOKEN=token-1; Path=/" } });
    const body = JSON.parse(String(init.body)) as { compareFilters: Array<{ fieldName: string; fieldValue: string | null }> };
    const name = body.compareFilters.find((filter) => filter.fieldName === "issuerName")?.fieldValue;
    if (name !== "WHIRLPOOL") return new Response("upstream down", { status: 502 });
    const rows = [{
      cusip: "963320BG0", issueSymbolIdentifier: "WHR6415676", issuerName: "WHIRLPOOL CORP", couponRate: 7.875,
      maturityDate: "2034-07-01", lastSalePrice: 88.055, lastSaleYield: 10.091, priceChangeNumber: -0.245,
      lastTradeDate: "2026-10-16", traceGradeCode: "H",
    }];
    const perpetual = body.compareFilters.some((filter) => filter.fieldName === "maturityDate" && filter.fieldValue === null);
    return Response.json(perpetual
      ? { status: "success", returnBody: { statusCode: 204, data: null } }
      : { status: "success", returnBody: { statusCode: 200, data: JSON.stringify(rows) } });
  });
}

test("a failed answer to a new query shows its failure, never the last query's rows, and keeps the search", async () => {
  tape();
  const config = createTestPaneConfig("/tmp/gloom-trace-test", { instanceId: "trace", paneId: TRACE_BONDS_PANE_ID });
  const initial = createInitialState(config);
  initial.focusedPaneId = "trace";
  initial.paneState.trace = { pluginState: { "trace-bonds": { issuer: "whirlpool" } } };
  const runtime = createTestPluginRuntime();
  let dispatch: (action: AppAction) => void = () => {};
  function Harness() {
    const [state, setState] = useState(initial);
    dispatch = (action) => setState((current) => appReducer(current, action));
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="trace" pluginId="trace-bonds" runtime={runtime} width={100} height={12}>
      {(body) => <TraceBondsPane paneId="trace" paneType={TRACE_BONDS_PANE_ID} focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 12 }); });
  await settle();
  expect(tui.frame()).toContain("WHIRLPOOL CORP");

  await act(async () => {
    dispatch({ type: "UPDATE_PLUGIN_PANE_STATE", paneId: "trace", pluginId: "trace-bonds", key: "issuer", value: "acme" });
  });
  await settle();
  const frame = tui.frame();
  expect(frame).not.toContain("WHIRLPOOL CORP");
  expect(frame).toContain("Bond tape unavailable.");
  expect(frame).toContain("upstream down");
  // The search still holds what was typed, to change it.
  expect(frame).toContain("acme");
});
