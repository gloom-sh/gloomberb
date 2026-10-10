import { afterEach, expect, test } from "bun:test";
import { act, useMemo, useReducer } from "react";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import type { TickerRecord } from "../../../types/ticker";
import { insiderModule } from "./index";

const InsiderView = insiderModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
function xml(amendment: boolean, owner = "SMITH ANNA B", cik = "111", explanationOnly = false) {
  return `<ownershipDocument><documentType>${amendment ? "4/A" : "4"}</documentType>${amendment ? "<dateOfOriginalSubmission>2026-08-20</dateOfOriginalSubmission>" : ""}<reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName><rptOwnerCik>${cik}</rptOwnerCik></reportingOwnerId></reportingOwner>${explanationOnly ? "" : `<nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle><transactionDate><value>2026-08-19</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${amendment ? 40 : 100}</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>`}${amendment ? "<footnotes><footnote id='F1'>Corrects the original disclosure.</footnote></footnotes>" : ""}</ownershipDocument>`;
}
function Harness({ width, ticker = createTestTicker("CONTROL") }: { width: number; ticker?: TickerRecord }) {
  const paneId = "insider:amendment:test";
  const symbol = ticker.metadata.ticker;
  const config = createTestPaneConfig("/tmp/unused-insider-pane-test", { instanceId: paneId, paneId: "insider", binding: { kind: "fixed", symbol } });
  const [state, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.tickers = new Map([[symbol, ticker]]);
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
async function mount(width: number, explanationOnly = false, ticker?: TickerRecord) {
  const filings = ["amendment", "original", "other"].map((accessionNumber) => ({ accessionNumber, form: accessionNumber === "amendment" ? "4/A" : "4",
    filingDate: new Date(`2026-08-${accessionNumber === "amendment" ? "21" : "20"}T00:00:00Z`), cik: "999", filingUrl: `https://www.sec.gov/${accessionNumber}` }));
  const asked: string[] = [];
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async (symbol) => { asked.push(symbol); return filings; },
    getSecFilingContent: async (filing) => filing.accessionNumber === "other" ? xml(false, "JONES BOB", "222") : xml(filing.accessionNumber === "amendment", "SMITH ANNA B", "111", explanationOnly && filing.accessionNumber === "amendment") })));
  await act(async () => { await tui.render(<Harness width={width} ticker={ticker} />, { width, height: 30 }); });
  await settle();
  return asked;
}
async function mountWindow(inWindow: number) {
  const day = 24 * 60 * 60 * 1000;
  const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);
  const filings = Array.from({ length: inWindow + 1 }, (_, index) => ({ accessionNumber: `f${index}`, form: "4",
    filingDate: new Date(Date.now() - (index < inWindow ? 1 + index % 60 : 120) * day), cik: "999", filingUrl: `https://www.sec.gov/f${index}` }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerName>SMITH ANNA B</rptOwnerName><rptOwnerCik>111</rptOwnerCik></reportingOwnerId></reportingOwner><nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle><transactionDate><value>${isoDate(new Date(filing.filingDate).getTime())}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></ownershipDocument>` })));
  await act(async () => { await tui.render(<Harness width={80} />, { width: 80, height: 30 }); });
  for (let i = 0; i < 40 && (i < 8 || tui.frame().includes("loading")); i++) await settle();
}
afterEach(() => {
  setSharedMarketDataCoordinator(null);
});

test("narrow actual amendment detail retains corrected shares, explanation, status and the existing Open action", async () => {
  await mount(48);
  // The amendment stays marked when the narrow pane drops columns.
  expect(tui.frame()).toMatch(/Anna B\. Smith\s+BUY 4\/A\s+\$400/);
  expect(tui.frame()).toMatch(/Anna B\. Smith\s+BUY\s+\$1k/);
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Original filed 2026-08-20");
  expect(frame).toContain("Corrects the original disclosure.");
  expect(frame).toMatch(/Shares\s+40\s/);
  expect(frame).toContain("⚠");
  expect(frame).toContain("[o]pen");
});

// Venue and currency stay empty when an unsaved ticker's quote is unavailable,
// as for a thin US listing after the close: unknown is not foreign.
test("a ticker with no quote and no venue reads its filings; a listing abroad keeps the notice", async () => {
  const notice = "Insider transactions are only shown for US equities.";
  expect(await mount(80, false, createTestTicker("CRBG", "CRBG", { exchange: "", currency: "" }))).toEqual(["CRBG"]);
  expect(tui.frame()).toMatch(/Anna B\. Smith\s+BUY/);
  expect(tui.frame()).not.toContain(notice);
  for (const ticker of [
    createTestTicker("VOD.L", "Vodafone", { exchange: "LSE", currency: "GBP" }),
    createTestTicker("7203.T", "Toyota", { exchange: "", currency: "" }),
  ]) {
    expect(await mount(80, false, ticker), ticker.metadata.ticker).toEqual([]);
    expect(tui.frame(), ticker.metadata.ticker).toContain(notice);
  }
});

test("owner filtering keeps explanation-only amendments and clears amendment status for independent owners", async () => {
  await mount(80, true);
  expect(tui.frame()).toContain("NOTICE 4/A");
  await act(async () => { tui.setup().mockInput.pressKey("f"); });
  await settle();
  expect(tui.frame()).toContain("Insider Anna B. Smith");
  expect(tui.frame()).toContain("NOTICE 4/A");
  expect(tui.frame()).toMatch(/Anna B\. Smith\s+BUY\s+Class A\s+100/);
  expect(tui.frame()).not.toContain("Bob Jones");
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
  expect(tui.frame()).toContain("Bob Jones");
  expect(tui.frame()).not.toContain("Anna B. Smith");
  expect(tui.frame()).not.toContain("⚠");
});

// Reading 25 and 121 filings one after another takes seconds on a loaded runner.
const WINDOW_TEST_TIMEOUT_MS = 30_000;

test("the 90-day totals load every filing in the window, past the first page", async () => {
  await mountWindow(25);
  const frame = tui.frame();
  expect(frame).toContain("2.5k shares");
  expect(frame).not.toContain("⚠");
}, WINDOW_TEST_TIMEOUT_MS);

test("a window larger than the cap still says the totals are partial", async () => {
  await mountWindow(121);
  const frame = tui.frame();
  expect(frame).toContain("12k shares");
  expect(frame).toContain("⚠");
}, WINDOW_TEST_TIMEOUT_MS);

async function mountMixed() {
  const recent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const day = recent.toISOString().slice(0, 10);
  const lines: Record<string, [owner: string, title: string, code: string, security: string, derivative: boolean]> = {
    buy: ["COOK TIMOTHY D", "Chief Executive Officer", "P", "Common Stock", false],
    sale: ["O'BRIEN DEIRDRE", "Senior Vice President", "S", "Common Stock", false],
    award: ["Lund Deanna H", "EVP & CFO", "A", "Restricted Stock Unit", true],
    tax: ["Lund Deanna H", "EVP & CFO", "F", "Common Stock", false],
  };
  const filings = Object.keys(lines).map((accessionNumber) => ({ accessionNumber, form: "4", filingDate: recent, cik: "999", filingUrl: `https://www.sec.gov/${accessionNumber}` }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => {
      const [owner, title, code, security, derivative] = lines[filing.accessionNumber]!;
      const tag = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
      return `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName><rptOwnerCik>${filing.accessionNumber}</rptOwnerCik></reportingOwnerId><reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner><${tag}><securityTitle><value>${security}</value></securityTitle><transactionDate><value>${day}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></${tag}></ownershipDocument>`;
    } })));
  await act(async () => { await tui.render(<Harness width={100} />, { width: 100, height: 30 }); });
  await settle();
}

test("the pane opens on open-market buys and sells, with the other lines one click away", async () => {
  await mountMixed();
  // Filings are read one after another; a loaded runner needs more frames.
  for (let i = 0; i < 40 && !tui.frame().includes("Other (2)"); i++) await settle();
  let frame = tui.frame();
  expect(frame).toContain("Other (2)");
  expect(frame).toContain("Buys and sells (2)");
  expect(frame).toMatch(/Timothy D\. Cook\s+CEO\s+BUY/);
  expect(frame).toMatch(/Deirdre O'Brien\s+SVP\s+SELL/);
  expect(frame).not.toContain("AWARD");
  expect(frame).not.toContain("not in this view");

  await act(async () => { await tui.clickFrameText("All (4)"); });
  await settle();
  frame = tui.frame();
  expect(frame).toMatch(/Deanna H\. Lund\s+CFO\s+AWARD\s+RSU/);
  expect(frame).toMatch(/Deanna H\. Lund\s+CFO\s+TAX/);
  // CSV export writes what the table shows, with full numbers and ISO dates.
  await exportPaneTable("insider:amendment:test", "insider.csv");
  const csv = takeSavedTextFile()!.text.trim().split("\n");
  expect(csv[0]).toBe("Date,Insider,Role,Type,Security,Shares,Price ($),Value ($)");
  expect(csv.some((row) => /^\d{4}-\d{2}-\d{2},Deanna H\. Lund,CFO,AWARD,Restricted Stock Unit,100,10,1000$/.test(row))).toBe(true);

  // The 90-day totals count buys and sales, so a view of the other lines says they are not in it.
  await act(async () => { await tui.clickFrameText("Other (2)"); });
  await settle();
  frame = tui.frame();
  expect(frame).not.toContain("Timothy D. Cook");
  expect(frame).toContain("not in this view");
});
