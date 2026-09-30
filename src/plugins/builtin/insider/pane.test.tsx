import { afterEach, expect, test } from "bun:test";
import { act, useMemo, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { insiderModule } from "./index";

const InsiderView = insiderModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
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
  return <TestPaneFrame state={state} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime} width={width} height={30} footerKeys>
    {(body) => <InsiderView paneId={paneId} paneType="insider" focused {...body} />}
  </TestPaneFrame>;
}
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await Bun.sleep(2); await tui.setup().renderOnce(); });
}
async function mount(width: number, explanationOnly = false) {
  const filings = ["amendment", "original", "other"].map((accessionNumber) => ({ accessionNumber, form: accessionNumber === "amendment" ? "4/A" : "4",
    filingDate: new Date(`2026-08-${accessionNumber === "amendment" ? "21" : "20"}T00:00:00Z`), cik: "999", filingUrl: `https://www.sec.gov/${accessionNumber}` }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => filing.accessionNumber === "other" ? xml(false, "B. OFFICER", "222") : xml(filing.accessionNumber === "amendment", "A. OFFICER", "111", explanationOnly && filing.accessionNumber === "amendment") })));
  await act(async () => { await tui.render(<Harness width={width} />, { width, height: 30 }); });
  await settle();
}
async function mountWindow(inWindow: number) {
  const day = 24 * 60 * 60 * 1000;
  const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);
  const filings = Array.from({ length: inWindow + 1 }, (_, index) => ({ accessionNumber: `f${index}`, form: "4",
    filingDate: new Date(Date.now() - (index < inWindow ? 1 + index % 60 : 120) * day), cik: "999", filingUrl: `https://www.sec.gov/f${index}` }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerName>A. OFFICER</rptOwnerName><rptOwnerCik>111</rptOwnerCik></reportingOwnerId></reportingOwner><nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle><transactionDate><value>${isoDate(new Date(filing.filingDate).getTime())}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></ownershipDocument>` })));
  await act(async () => { await tui.render(<Harness width={80} />, { width: 80, height: 30 }); });
  for (let i = 0; i < 40 && (i < 8 || tui.frame().includes("loading")); i++) await settle();
}
afterEach(() => {
  setSharedMarketDataCoordinator(null);
});

test("narrow actual amendment detail retains corrected shares, explanation, status and the existing Open action", async () => {
  await mount(48);
  expect(tui.frame()).toContain("4/A · BUY 40");
  expect(tui.frame()).toContain("BUY 100");
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Original filed 2026-08-20");
  expect(frame).toContain("Corrects the original disclosure.");
  expect(frame).toContain("Shares: 40");
  expect(frame).toContain("⚠");
  expect(frame).toContain("[o]pen");
});

test("owner filtering keeps explanation-only amendments and clears amendment status for independent owners", async () => {
  await mount(80, true);
  expect(tui.frame()).toContain("Form 4/A disclosure");
  await act(async () => { tui.setup().mockInput.pressKey("f"); });
  await settle();
  expect(tui.frame()).toContain("Form 4/A disclosure");
  expect(tui.frame()).toContain("BUY 100");
  expect(tui.frame()).not.toContain("B. OFFICER");
  await act(async () => { tui.setup().mockInput.pressKey("f"); });
  await settle();
  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await tui.emitKeypress({ name: "down", sequence: "\u001b[B" }, { trackPropagation: true });
  await act(async () => { await Bun.sleep(180); });
  await settle();
  const rows = tui.frame().split("\n");
  const row = rows.findIndex((line) => line.includes("[f]ilter"));
  await act(async () => { await tui.setup().mockMouse.click(rows[row]!.indexOf("[f]ilter") + 2, row); });
  await settle();
  expect(tui.frame()).toContain("B. OFFICER");
  expect(tui.frame()).not.toContain("A. OFFICER");
  expect(tui.frame()).not.toContain("⚠");
});

test("the 90-day totals load every filing in the window, past the first page", async () => {
  await mountWindow(25);
  const frame = tui.frame();
  expect(frame).toContain("2.5k shares");
  expect(frame).not.toContain("⚠");
});

test("a window larger than the cap still says the totals are partial", async () => {
  await mountWindow(121);
  const frame = tui.frame();
  expect(frame).toContain("12k shares");
  expect(frame).toContain("⚠");
});
