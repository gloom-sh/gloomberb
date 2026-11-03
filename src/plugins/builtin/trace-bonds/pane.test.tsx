import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import type { StoredBondPayload } from "../../../api-client/bond-trades";
import { ApiRequestError } from "../../../api-client/errors";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { TRACE_BONDS_PANE_ID } from "./model";
import { TraceBondsPane } from "./pane";

const tui = createOpenTuiTestHarness();
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  setHttpFetchTransport(null);
  for (const spy of spies.splice(0)) spy.mockRestore();
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

/** The pane on one query, as a Pro account sees it. */
async function renderTrace(issuer: string, size = { width: 100, height: 26 }) {
  spies.push(spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "u1", plan: "pro", emailVerified: true } as ReturnType<typeof apiClient.getCurrentUser>));
  const config = createTestPaneConfig("/tmp/gloom-trace-test", { instanceId: "trace", paneId: TRACE_BONDS_PANE_ID });
  const initial = createInitialState(config);
  initial.focusedPaneId = "trace";
  initial.paneState.trace = { pluginState: { "trace-bonds": { issuer } } };
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((current) => appReducer(current, action));
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="trace" pluginId="trace-bonds" runtime={runtime} width={size.width} height={size.height}>
      {(body) => <TraceBondsPane paneId="trace" paneType={TRACE_BONDS_PANE_ID} focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, size); });
  await settle();
  return tui.frame();
}

const NFE_BOND = {
  cusip: "644393AC4", issueSymbolIdentifier: "NFE5833345", issuerName: "NEW FORTRESS ENERGY INC", couponRate: 8.75,
  maturityDate: "2029-03-15", lastSalePrice: 52.5, lastSaleYield: 28.4, priceChangeNumber: -1.25, lastTradeDate: "2026-10-30",
};

test("a CUSIP opens on its kept daily closes and prints, saying since when; nothing before that date is drawn", async () => {
  setHttpFetchTransport(async (_url, init) => {
    if (!init?.method) return new Response("", { headers: { "set-cookie": "XSRF-TOKEN=token-1; Path=/" } });
    return Response.json({ status: "success", returnBody: { statusCode: 200, data: JSON.stringify([NFE_BOND]) } });
  });
  const print = (date: string, price: number) => ({ date, time: "14:02:11", status: "trade" as const, cancelled: false, price, yield: 30 - price / 10, quantity: 250_000, quantityCapped: false, side: "sell" as const });
  const history: StoredBondPayload = {
    cusip: "644393AC4", issuerName: "NEW FORTRESS ENERGY INC", coupon: 8.75, maturity: "2029-03-15",
    issuer: { symbol: "NFE", name: "New Fortress Energy Inc." }, from: "2023-10-28", to: "2026-11-01",
    trades: [print("2026-10-30", 52.5), print("2026-10-29", 53.75), { ...print("2026-10-28", 0), status: "cancel" }],
    truncated: false, keptSince: "2024-03-05", backfillPending: false,
    days: [
      { date: "2024-03-05", prints: 4, price: 97.25, yield: 9.4 },
      { date: "2026-10-29", prints: 2, price: 53.75, yield: 25.1 },
      { date: "2026-10-30", prints: 1, price: 52.5, yield: 28.4 },
    ],
  };
  const read = spyOn(apiClient, "getCloudStoredBond").mockResolvedValue(history);
  spies.push(read);
  const frame = await renderTrace("644393AC4");
  expect(read.mock.calls[0]?.[0]).toBe("644393AC4");
  expect(frame).toContain("NEW FORTRESS ENERGY INC 8.750 2029-03-15");
  expect(frame).toContain("Kept since");
  expect(frame).toContain("2024-03-05");
  expect(frame).toContain("53.750");
  // A cancel says nothing about the price: it is not a row.
  expect(frame).not.toContain("2026-10-28");
});

test("a kept history refused for the plan or missing says so in the detail, and the tape still answers", async () => {
  setHttpFetchTransport(async (_url, init) => {
    if (!init?.method) return new Response("", { headers: { "set-cookie": "XSRF-TOKEN=token-1; Path=/" } });
    return Response.json({ status: "success", returnBody: { statusCode: 200, data: JSON.stringify([NFE_BOND]) } });
  });
  spies.push(spyOn(apiClient, "getCloudStoredBond").mockRejectedValue(new ApiRequestError("No stored bond 644393AC4", 404)));
  const frame = await renderTrace("644393AC4");
  expect(frame).toContain("No kept price history for this bond.");
  expect(frame).toContain("52.500");
});

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
