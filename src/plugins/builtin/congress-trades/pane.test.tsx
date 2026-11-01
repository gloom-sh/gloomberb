import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport, type CloudCongressHousePayload, type CloudCongressTradePayload } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { CongressPane } from "./pane";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); });

const trade = (id: string, overrides: Partial<CloudCongressTradePayload> = {}): CloudCongressTradePayload => ({
  id, filingId: id, docId: id, chamber: "house", memberName: "Jane Doe", stateDistrict: "CA11",
  filingDate: "2026-09-01", transactionDate: "2026-08-03", notificationDate: null, lagDays: 29,
  side: "BUY", transactionType: "Purchase", ticker: "NVDA", assetName: "NVIDIA Corporation", assetType: "ST",
  owner: "Self", rawOwner: "", amount: "$15,001 - $50,000", amountLow: 15001, amountHigh: 50000,
  capGainsOver200: null, filingStatus: null, subholdingOf: null, description: null, sourceUrl: "",
  returnSinceTx: 12, returnSinceFiling: 8, spyReturnSinceTx: 15, spyReturnSinceFiling: 6,
  excessSinceTx: -3, excessSinceFiling: 2, returnAsOf: "2026-10-29", party: "Democrat", committees: [],
  ...overrides,
});

const payload: CloudCongressHousePayload = {
  asOf: "2026-10-30T00:00:00.000Z", chamber: "all", source: "congress", year: 2026, indexUpdatedAt: null,
  filingsScanned: 2, filingCount: 2, filingOffset: 0, hasMore: false, hasMoreFilings: false, nextOffset: 3, nextFilingOffset: 2,
  trades: [
    trade("buy"),
    // A sale reads against SPY like any trade; the median runs over the trades that have a figure.
    trade("sell", { side: "SELL", transactionType: "Sale", filingDate: "2026-08-20", excessSinceFiling: 9.5 }),
    trade("unpriced", { filingDate: "2026-08-10", returnSinceTx: null, returnSinceFiling: null, spyReturnSinceTx: null, spyReturnSinceFiling: null, excessSinceTx: null, excessSinceFiling: null }),
  ],
  members: [],
};

async function mount(width: number) {
  setCloudApiFetchTransport(async () => Response.json(payload));
  const paneId = "congress-trades:test";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-cg-test", { paneId: "congress-trades", instanceId: paneId, binding: { kind: "none" } }));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneFrame state={current} dispatch={dispatch} paneId={paneId} pluginId="gloomberb-cloud" runtime={runtime} width={width} height={24} footerKeys>
      {(body) => <CongressPane paneId={paneId} paneType="congress-trades" {...body} focused />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height: 24 }); });
}

test("VS SPY reads the excess since filing, and a trade's detail shows SPY over both windows", async () => {
  await mount(160);
  const table = await tui.waitForFrameToContain("VS SPY");
  expect(table).toContain("TX RET%");
  expect(table).toContain("FILE RET%");
  expect(table).toMatch(/\+12\.0%\s+\+8\.0%\s+\+2\.0%/);
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("tx vs SPY");
  expect(detail).toMatch(/tx return\s+\+12\.0%/);
  expect(detail).toMatch(/tx vs SPY\s+-3\.0%\s+SPY \+15\.0%/);
  expect(detail).toMatch(/filed vs SPY\s+\+2\.0%\s+SPY \+6\.0%/);
});

test("members show the median against SPY, and a member's trades carry the column", async () => {
  await mount(160);
  await tui.waitForFrameToContain("VS SPY");
  await tui.emitKeypress({ name: "2" });
  const members = await tui.waitForFrameToContain("MED VS SPY");
  // Both priced trades returned 12% since the trade; against SPY since the filing, 2 and 9.5.
  expect(members).toMatch(/\+12\.0%\s+\+5\.8%/);
  await tui.emitKeypress({ name: "return" });
  const detail = await tui.waitForFrameToContain("Median vs SPY");
  expect(detail).toContain("+5.8%");
  expect(detail).toContain("since filing, 2 priced");
  expect(detail).toContain("VS SPY");
  expect(detail).toContain("+9.5%");
});
