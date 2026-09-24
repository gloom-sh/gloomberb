import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { emitKeypress as emitTuiKeypress, testRender, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { TickerResearchTabDef } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { TickerResearchPane } from "../ticker-detail/pane";
import { TICKER_RESEARCH_BUILTIN_TABS } from "../ticker-detail/research-tabs";
import { ThirteenFPane } from "./pane";
import { ThirteenFTickerPane } from "./signals-pane";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";

const PANE_ID = "thirteenf-pane-test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let latestState: AppState | null = null;

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  latestState = null;
  setHttpFetchTransport(null);
});

function Harness() {
  const initialState = createInitialState(createDefaultConfig("/tmp/gloomberb-thirteenf-pane-test"));
  initialState.focusedPaneId = PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);
  latestState = state;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <ThirteenFPane
        paneId={PANE_ID}
        paneType="thirteenf-funds"
        focused
        width={96}
        height={18}
      />
    </TestPaneProvider>
  );
}

async function renderFrames(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

const emitKeypress = (event: TestKeyEvent) => emitTuiKeypress(testSetup!, event, { trackPropagation: true });

const emitKeypressBatch = (events: TestKeyEvent[]) => emitTuiKeypress(testSetup!, events, { trackPropagation: true });

function installAlpha13FTransport(urls: string[] = []) {
  setHttpFetchTransport(async (url) => {
    urls.push(String(url));
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    if (path.endsWith("/topfunds")) {
      return json([
        { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
      ]);
    }
    if (path.endsWith("/ticker-holdings")) {
      return json({
        ticker: "AAPL", quarter: "2026Q1", period: "2026-03-31", previousPeriod: "2025-12-31", warnings: [], asOf: "2026-05-15",
        rows: [{
          id: "1:AAPL", cik: "0000000001", fund: "Alpha Capital", ticker: "AAPL", cusip: "037833100", issuer: "Apple Inc.", type: "COM",
          value: 90, shares: 1000, weight: 0.75, previousWeight: null, weightChange: null, action: "new",
        }],
        holderCount: 1, newCount: 1, exitCount: 0, totalValue: 90, valueScope: "all funds", hasMore: false, nextOffset: 1,
      });
    }
    if (path.endsWith("/forms")) {
      return json([
        {
          cik: "0000000001",
          accession_number: "0000000001-26-000001",
          submission_type: "13F-HR/A",
          period_of_report: "2026-03-31",
          filed_as_of_date: "2026-05-15",
          company_name: "Alpha Capital",
          table_value_total: 120,
          table_entry_total: 2,
          is_amendment: true,
          amendment_type: "RESTATEMENT",
          url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/filing.txt",
        },
        {
          cik: "0000000001",
          accession_number: "0000000001-25-000004",
          submission_type: "13F-HR",
          period_of_report: "2025-12-31",
          filed_as_of_date: "2026-02-14",
          company_name: "Alpha Capital",
          table_value_total: 100,
          table_entry_total: 2,
          is_amendment: false,
          url: "https://www.sec.gov/Archives/edgar/data/1/000000000125000004/filing.txt",
        },
      ]);
    }
    if (path.endsWith("/form")) {
      return json([
        {
          cik: "0000000001",
          accession_number: parsed.searchParams.get("accession_number"),
          name_of_issuer: "Apple Inc.",
          title_of_class: "COM",
          cusip: "037833100",
          ticker: "AAPL",
          value: 90,
          ssh_prnamt: 1000,
          ssh_prnamt_type: "SH",
          put_call: "CALL",
          investment_discretion: "SOLE",
          voting_authority_sole: 1000,
          voting_authority_shared: 0,
          voting_authority_none: 0,
        },
      ]);
    }
    return json([]);
  });
}

describe("ThirteenFPane", () => {
  test("keyboard navigation starts from the first rendered sorted row", async () => {
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/topfunds")) {
        return json([
          { cik: "3", name: "Zeta Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "2", name: "Beta Capital", period_of_report: "2026-03-31", pnl: null },
        ]);
      }
      return json([]);
    });

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();
    const frame = testSetup!.captureCharFrame();
    expect(frame.indexOf("Alpha Capital")).toBeLessThan(frame.indexOf("Beta Capital"));
    expect(frame.indexOf("Beta Capital")).toBeLessThan(frame.indexOf("Zeta Capital"));

    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(2);

    expect(testSetup!.captureCharFrame()).toContain("Back Beta Capital");
    expect(
      latestState?.paneState[PANE_ID]?.pluginState?.thirteenf?.selectedId,
    ).toBeUndefined();
  });

  test("moves from the first fund row to search with Up", async () => {
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/topfunds")) {
        return json([
          { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
        ]);
      }
      return json([]);
    });

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await act(async () => {
      await testSetup!.mockInput.typeText("BRK");
      await testSetup!.renderOnce();
    });
    await renderFrames(2);

    expect(testSetup!.captureCharFrame()).toContain("BRK");
  });

  test("rapid keyboard navigation activates the current rendered row", async () => {
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/topfunds")) {
        return json([
          { cik: "3", name: "Zeta Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "1", name: "Alpha Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "4", name: "Gamma Capital", period_of_report: "2026-03-31", pnl: null },
          { cik: "2", name: "Beta Capital", period_of_report: "2026-03-31", pnl: null },
        ]);
      }
      return json([]);
    });

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();

    await emitKeypressBatch([
      { name: "down", sequence: "\u001B[B" },
      { name: "down", sequence: "\u001B[B" },
      { name: "enter", sequence: "\r" },
    ]);
    await renderFrames(2);

    expect(testSetup!.captureCharFrame()).toContain("Back Gamma Capital");
    expect(
      latestState?.paneState[PANE_ID]?.pluginState?.thirteenf?.selectedId,
    ).toBeUndefined();
  });

  test("filing shortcut on a holding opens filing detail inside the pane", async () => {
    installAlpha13FTransport();

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 24 });
    });
    await renderFrames();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "f", sequence: "f" });
    await renderFrames(6);

    const detailFrame = testSetup!.captureCharFrame();
    expect(detailFrame).toContain("Back 2026-03-31 filing");
    expect(detailFrame).toContain("Accession");
    expect(detailFrame).toContain("0000000001-26-000001");
    expect(detailFrame).toContain("Apple Inc.");

    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);

    const holdingsFrame = testSetup!.captureCharFrame();
    expect(holdingsFrame).toContain("Holdings");
    expect(holdingsFrame).toContain("filed 2026-05-15, restated");
    expect(holdingsFrame).toContain("AAPL");
    expect(holdingsFrame).not.toContain("Accession");
  });

  test("filing detail owns refresh requests and backspace returns to filings", async () => {
    const urls: string[] = [];
    installAlpha13FTransport(urls);

    await act(async () => {
      testSetup = await testRender(<Harness />, { width: 100, height: 24 });
    });
    await renderFrames();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);

    const detailFrame = testSetup!.captureCharFrame();
    expect(detailFrame).toContain("Accession");
    expect(detailFrame).toContain("0000000001-26-000001");
    expect(detailFrame).toContain("Restatement");
    expect(detailFrame).toContain("Alpha Capital");
    expect(detailFrame).toContain("Apple Inc.");
    expect(detailFrame).toContain("CALL");
    expect(detailFrame).toContain("037833100");
    expect(detailFrame).toContain("SOLE");

    urls.length = 0;
    await emitKeypress({ name: "r", sequence: "r" });
    await renderFrames(6);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).pathname).toEndWith("/form");
    expect(new URL(urls[0]!).searchParams.get("accession_number")).toBe("0000000001-26-000001");

    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);

    const filingsFrame = testSetup!.captureCharFrame();
    expect(filingsFrame).toContain("PERIOD");
    expect(filingsFrame).toContain("Restatement");
    expect(filingsFrame).toContain("Back Alpha Capital");
    expect(filingsFrame).not.toContain("Accession");
  });
  test("back from an overlap keeps the first fund open and returns to the second fund picker", async () => {
    installAlpha13FTransport();
    await act(async () => { testSetup = await testRender(<Harness />, { width: 110, height: 26 }); });
    await renderFrames();
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await testSetup!.mockInput.typeText("0000000001"); });
    await renderFrames(2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await renderFrames(4);
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    expect(testSetup!.captureCharFrame()).toContain("SECOND %");
    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);
    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("Back Alpha Capital");
    expect(frame).toContain("Overlap");
    expect(frame).not.toContain("SECOND %");
  });

  test("slash in a fund opened from a ticker query reaches the overlap search", async () => {
    installAlpha13FTransport();
    await act(async () => { testSetup = await testRender(<Harness />, { width: 110, height: 26 }); });
    await renderFrames();
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await testSetup!.mockInput.typeText("AAPL"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await renderFrames(4);
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    expect(testSetup!.captureCharFrame()).toContain("Back Alpha Capital");
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await testSetup!.mockInput.typeText("0000000009"); });
    await renderFrames(2);
    expect(testSetup!.captureCharFrame()).toContain("0000000009");
  }, 20_000);

  test("in the Research pane, h/l move an open fund's sections instead of the research tabs", async () => {
    installAlpha13FTransport();
    const researchPaneId = "ticker-research:13f-test";
    const tabs = new Map<string, TickerResearchTabDef>(
      [...TICKER_RESEARCH_BUILTIN_TABS, { id: "thirteenf", name: "13F", order: 39, component: ThirteenFTickerPane }]
        .map((tab) => [tab.id, tab]),
    );
    setSharedRegistryForTests({ tickerResearchTabs: tabs } as unknown as PluginRegistry);
    function ResearchHarness() {
      const config = createTestPaneConfig("/tmp/gloomberb-thirteenf-research-test", {
        instanceId: researchPaneId,
        paneId: TICKER_RESEARCH_PANE_ID,
        binding: { kind: "fixed", symbol: "AAPL" },
      });
      const initialState = createInitialState(config);
      initialState.focusedPaneId = researchPaneId;
      initialState.tickers = new Map([["AAPL", createTestTicker("AAPL")]]);
      initialState.paneState[researchPaneId] = { activeTabId: "thirteenf" };
      const [state, dispatch] = useReducer(appReducer, initialState);
      latestState = state;
      return (
        <TestPaneProvider state={state} dispatch={dispatch} paneId={researchPaneId} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
          <TickerResearchPane paneId={researchPaneId} paneType={TICKER_RESEARCH_PANE_ID} focused width={100} height={24} />
        </TestPaneProvider>
      );
    }
    try {
      await act(async () => { testSetup = await testRender(<ResearchHarness />, { width: 100, height: 26 }); });
      await renderFrames(6);
      await emitKeypress({ name: "enter", sequence: "\r" });
      await renderFrames(6);
      expect(testSetup!.captureCharFrame()).toContain("Back Alpha Capital");

      await emitKeypress({ name: "l", sequence: "l" });
      await renderFrames(2);
      const filings = testSetup!.captureCharFrame();
      expect(filings).toContain("PERIOD");
      expect(latestState?.paneState[researchPaneId]?.activeTabId).toBe("thirteenf");

      // Back on the holders list, the research strip has h/l again.
      await emitKeypress({ name: "escape", sequence: "\u001B" });
      await renderFrames(2);
      await emitKeypress({ name: "h", sequence: "h" });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
      await renderFrames(2);
      expect(latestState?.paneState[researchPaneId]?.activeTabId).toBe("overview");
    } finally {
      setSharedRegistryForTests(undefined);
    }
  }, 20_000);

});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
