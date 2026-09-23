import { afterEach, expect, test } from "bun:test";
import { act, useMemo, useReducer } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { insiderModule } from "./index";

const InsiderView = insiderModule.panes![0]!.component;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
function xml(amendment: boolean, owner = "A. OFFICER", cik = "111", explanationOnly = false) {
  return `<ownershipDocument><documentType>${amendment ? "4/A" : "4"}</documentType>${amendment ? "<dateOfOriginalSubmission>2026-08-20</dateOfOriginalSubmission>" : ""}<reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName><rptOwnerCik>${cik}</rptOwnerCik></reportingOwnerId></reportingOwner>${explanationOnly ? "" : `<nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle><transactionDate><value>2026-08-19</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${amendment ? 40 : 100}</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>`}${amendment ? "<footnotes><footnote id='F1'>Corrects the original disclosure.</footnote></footnotes>" : ""}</ownershipDocument>`;
}
function Harness({ width }: { width: number }) {
  const paneId = "insider:amendment:test";
  const config = createTestPaneConfig("/tmp/unused-insider-pane-test", { instanceId: paneId, paneId: "insider", binding: { kind: "fixed", symbol: "CONTROL" } });
  const [state, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.tickers = new Map([["CONTROL", createTestTicker("CONTROL")]]);
    initial.focusedPaneId = paneId;
    return initial;
  });
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return <TestPaneProvider state={state} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
    <PaneFooterProvider>{(footer) => <Box width={width} height={30} flexDirection="column">
      <Box width={width} height={29}><InsiderView paneId={paneId} paneType="insider" focused width={width} height={29} /></Box>
      <PaneFooterBar footer={footer} focused width={width} />
      <PaneFooterKeys paneId={paneId} footer={footer} focused />
    </Box>}</PaneFooterProvider>
  </TestPaneProvider>;
}
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Bun.sleep(2); await setup!.renderOnce(); });
}
async function mount(width: number, explanationOnly = false) {
  const filings = ["amendment", "original", "other"].map((accessionNumber) => ({ accessionNumber, form: accessionNumber === "amendment" ? "4/A" : "4",
    filingDate: new Date(`2026-08-${accessionNumber === "amendment" ? "21" : "20"}T00:00:00Z`), cik: "999", filingUrl: `https://www.sec.gov/${accessionNumber}` }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => filing.accessionNumber === "other" ? xml(false, "B. OFFICER", "222") : xml(filing.accessionNumber === "amendment", "A. OFFICER", "111", explanationOnly && filing.accessionNumber === "amendment") })));
  await act(async () => { setup = await testRender(<Harness width={width} />, { width, height: 30 }); });
  await settle();
}
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  setSharedMarketDataCoordinator(null);
});

test("narrow actual amendment detail retains corrected shares, explanation, status and the existing Open action", async () => {
  await mount(48);
  expect(setup!.captureCharFrame()).toContain("4/A · BUY 40");
  expect(setup!.captureCharFrame()).toContain("BUY 100");
  await act(async () => { setup!.mockInput.pressEnter(); });
  await settle();
  const frame = setup!.captureCharFrame();
  expect(frame).toContain("Original filed 2026-08-20");
  expect(frame).toContain("Corrects the original disclosure.");
  expect(frame).toContain("Shares: 40");
  expect(frame).toContain("⚠");
  expect(frame).toContain("[o]pen");
});

test("owner filtering keeps explanation-only amendments and clears amendment status for independent owners", async () => {
  await mount(80, true);
  expect(setup!.captureCharFrame()).toContain("Form 4/A disclosure");
  await act(async () => { setup!.mockInput.pressKey("f"); });
  await settle();
  expect(setup!.captureCharFrame()).toContain("Form 4/A disclosure");
  expect(setup!.captureCharFrame()).toContain("BUY 100");
  expect(setup!.captureCharFrame()).not.toContain("B. OFFICER");
  await act(async () => { setup!.mockInput.pressKey("f"); });
  await settle();
  await emitKeypress(setup!, { name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await emitKeypress(setup!, { name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await act(async () => { await Bun.sleep(180); });
  await settle();
  const rows = setup!.captureCharFrame().split("\n");
  const row = rows.findIndex((line) => line.includes("[f]ilter"));
  await act(async () => { await setup!.mockMouse.click(rows[row]!.indexOf("[f]ilter") + 2, row); });
  await settle();
  expect(setup!.captureCharFrame()).toContain("B. OFFICER");
  expect(setup!.captureCharFrame()).not.toContain("A. OFFICER");
  expect(setup!.captureCharFrame()).not.toContain("⚠");
});
