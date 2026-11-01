import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { outage } from "../../../test-support/outage";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import type { CorporateActionsData } from "../../../types/financials";
import type { TickerResearchTabDef } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { TickerResearchPane } from "../ticker-detail/pane";
import { TICKER_RESEARCH_BUILTIN_TABS } from "../ticker-detail/research-tabs";
import { ThirteenFPane } from "./pane";
import { ThirteenFTickerPane } from "./signals-pane";
import { TestPaneFrame, TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachThirteenFApiPersistence, resetThirteenFApiPersistence } from "./api";
import { TestShellPaneKeys } from "../../../test-support/shell-pane-keys";
import { ONE_SHOT_COOLDOWN_MS } from "../../../utils/one-shot";
import { fundListCache, fundMembersCache } from "../members/client";

const PANE_ID = "thirteenf-pane-test";

const tui = createOpenTuiTestHarness();
let latestState: AppState | null = null;

afterEach(() => {
  latestState = null;
  resetThirteenFApiPersistence();
  fundListCache.reset();
  fundMembersCache.reset();
  setHttpFetchTransport(null);
  setSystemTime();
});

function Harness({ marketData = null }: { marketData?: DataProvider | null }) {
  const initialState = createInitialState(createDefaultConfig("/tmp/gloomberb-thirteenf-pane-test"));
  initialState.focusedPaneId = PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);
  latestState = state;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime({ getMarketData: () => marketData })}>
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
      await tui.setup().renderOnce();
    });
  }
}

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event, { trackPropagation: true });

const emitKeypressBatch = (events: TestKeyEvent[]) => tui.emitKeypress(events, { trackPropagation: true });

function installAlpha13FTransport(urls: string[] = [], override?: (path: string, parsed: URL) => Response | null) {
  setHttpFetchTransport(async (url) => {
    urls.push(String(url));
    const parsed = new URL(String(url));
    if (!parsed.pathname.endsWith("/holdings")) return respond(parsed);
    // Gloom Cloud sends a filing whole: the rows `/form` serves a page at a time.
    const page = new URL(parsed);
    page.pathname = page.pathname.replace(/\/holdings$/, "/form");
    const response = respond(page);
    return response.ok ? json({ rows: await response.json(), complete: true }) : response;
  });

  function respond(parsed: URL): Response {
    const path = parsed.pathname;
    const answer = override?.(path, parsed);
    if (answer) return answer;
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
  }
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
      await tui.render(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();
    const frame = tui.frame();
    expect(frame.indexOf("Alpha Capital")).toBeLessThan(frame.indexOf("Beta Capital"));
    expect(frame.indexOf("Beta Capital")).toBeLessThan(frame.indexOf("Zeta Capital"));

    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(2);

    expect(tui.frame()).toContain("Back Beta Capital");
    expect(
      latestState?.paneState[PANE_ID]?.pluginState?.thirteenf?.selectedId,
    ).toBeUndefined();
  });

  test("a refresh that fails shows the funds' saved copy, its filing columns filled, and says when it was saved", async () => {
    attachThirteenFApiPersistence(new MemoryPluginPersistence());
    let offline = false;
    setHttpFetchTransport(async (url) => {
      if (offline) throw outage();
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/funds")) return json([{ cik: "1067983", name: "BERKSHIRE HATHAWAY INC" }]);
      // The filings answer after the rows are drawn, as they do from the network.
      if (path.endsWith("/forms")) {
        await Bun.sleep(30);
        return json([{ accession_number: "0001067983-26-000001", cik: "1067983", company_name: "BERKSHIRE HATHAWAY INC",
          period_of_report: "2026-06-30", filed_as_of_date: "2026-08-14", submission_type: "13F-HR", table_value_total: 299_250_000_000, table_entry_total: 89 }]);
      }
      return json([]);
    });
    const state = createInitialState(createTestPaneConfig("/tmp/gloomberb-thirteenf-pane-test", {
      instanceId: PANE_ID, paneId: "thirteenf-funds", settings: { query: "Berkshire Hathaway" },
    }));
    state.focusedPaneId = PANE_ID;
    await act(async () => {
      await tui.render(
        <TestPaneFrame state={state} dispatch={() => {}} paneId={PANE_ID} pluginId="ticker-research" runtime={createTestPluginRuntime()} width={100} height={20}>
          {(body) => <ThirteenFPane paneId={PANE_ID} paneType="thirteenf-funds" focused {...body} />}
        </TestPaneFrame>,
        { width: 100, height: 20 },
      );
    });
    expect(await tui.waitForFrameToContain("2026-06-30")).toContain("$299.25B");

    offline = true;
    await emitKeypress({ name: "r", sequence: "r" });
    await tui.waitForFrameToContain("saved copy from");
    const saved = await tui.waitForFrameToContain("2026-06-30");
    expect(saved).toContain("$299.25B");
    expect(saved).not.toMatch(/refresh failed|Retained data|Unable to connect/);

    offline = false;
    await emitKeypress({ name: "r", sequence: "r" });
    await tui.waitForFrameToExclude("saved copy");
    expect(await tui.waitForFrameToContain("2026-06-30")).toContain("$299.25B");
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
      await tui.render(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await act(async () => {
      await tui.setup().mockInput.typeText("BRK");
      await tui.setup().renderOnce();
    });
    await renderFrames(2);

    expect(tui.frame()).toContain("BRK");
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
      await tui.render(<Harness />, { width: 100, height: 20 });
    });
    await renderFrames();

    await emitKeypressBatch([
      { name: "down", sequence: "\u001B[B" },
      { name: "down", sequence: "\u001B[B" },
      { name: "enter", sequence: "\r" },
    ]);
    await renderFrames(2);

    expect(tui.frame()).toContain("Back Gamma Capital");
    expect(
      latestState?.paneState[PANE_ID]?.pluginState?.thirteenf?.selectedId,
    ).toBeUndefined();
  });

  test("leaves Cmd/Ctrl+Shift+R to window resize mode, and r still refreshes", async () => {
    const urls: string[] = [];
    installAlpha13FTransport(urls);
    const modes: Array<string | undefined> = [];

    await act(async () => {
      await tui.render(
        <>
          <Harness />
          <TestShellPaneKeys focusedPaneId={PANE_ID} startWindowMode={(_paneId, mode) => { modes.push(mode); }} />
        </>,
        { width: 100, height: 20 },
      );
    });
    await renderFrames();
    expect(tui.frame()).toContain("Alpha Capital");

    urls.length = 0;
    await emitKeypress({ name: "r", sequence: "R", ctrl: true, shift: true });
    // A separate press: a held chord would not run window resize mode twice.
    setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
    await emitKeypress({ name: "r", sequence: "R", super: true, shift: true });
    await renderFrames(4);
    expect(modes).toEqual(["resize", "resize"]);
    expect(urls).toEqual([]);

    await emitKeypress({ name: "r", sequence: "r" });
    await renderFrames(4);
    expect(modes).toHaveLength(2);
    expect(urls.map((url) => new URL(url).pathname)).toContainEqual(expect.stringMatching(/\/topfunds$/));
  });

  test("filing shortcut on a holding opens filing detail inside the pane", async () => {
    installAlpha13FTransport();

    await act(async () => {
      await tui.render(<Harness />, { width: 100, height: 24 });
    });
    await renderFrames();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "f", sequence: "f" });
    await renderFrames(6);

    const detailFrame = tui.frame();
    expect(detailFrame).toContain("Back 2026-03-31 filing");
    expect(detailFrame).toContain("Accession");
    expect(detailFrame).toContain("0000000001-26-000001");
    expect(detailFrame).toContain("Apple Inc.");

    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);

    const holdingsFrame = tui.frame();
    expect(holdingsFrame).toContain("Holdings");
    expect(holdingsFrame).toContain("filed 2026-05-15, restated");
    expect(holdingsFrame).toContain("AAPL");
    expect(holdingsFrame).not.toContain("Accession");
  });

  test("a line that moved as across a split has no Est P&L until its corporate actions answer, then the split-adjusted figure, never the crash", async () => {
    // KLAC 10:1: 10 shares at 100 become 100 at 12. Read as value over shares that is -$880; split-adjusted it is +$200.
    const holdings = { "0000000001-26-000001": { value: 1200, ssh_prnamt: 100 }, "0000000001-25-000004": { value: 1000, ssh_prnamt: 10 } };
    installAlpha13FTransport([], (path, parsed) => {
      if (path.endsWith("/forms")) return json([
        { cik: "0000000001", accession_number: "0000000001-26-000001", submission_type: "13F-HR", period_of_report: "2026-03-31", filed_as_of_date: "2026-05-15", company_name: "Alpha Capital", table_value_total: 1200, table_entry_total: 1, is_amendment: false },
        { cik: "0000000001", accession_number: "0000000001-25-000004", submission_type: "13F-HR", period_of_report: "2025-12-31", filed_as_of_date: "2026-02-14", company_name: "Alpha Capital", table_value_total: 1000, table_entry_total: 1, is_amendment: false },
      ]);
      const accession = parsed.searchParams.get("accession_number") as keyof typeof holdings;
      return path.endsWith("/form")
        ? json([{ cik: "0000000001", accession_number: accession, name_of_issuer: "KLA Corp", title_of_class: "COM", cusip: "482480100", ticker: "KLAC", ssh_prnamt_type: "SH", ...holdings[accession] }])
        : null;
    });
    const actions = Promise.withResolvers<CorporateActionsData>();
    const lookups: string[] = [];
    const marketData = createTestDataProvider({ getCorporateActions: (ticker) => { lookups.push(ticker); return actions.promise; } });

    await act(async () => {
      await tui.render(<Harness marketData={marketData} />, { width: 100, height: 24 });
    });
    await renderFrames();
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);

    // The table is up while the lookup is out, with no figure to read as a crash.
    expect(lookups).toEqual(["KLAC"]);
    const waiting = tui.frame();
    expect(waiting).toContain("KLAC");
    expect(waiting).not.toContain("-$880");
    expect(waiting).not.toContain("$200");

    actions.resolve({ symbol: "KLAC", dividends: [], earnings: [], splits: [{ date: "2026-02-05", fromFactor: 1, toFactor: 10 }] });
    await renderFrames(4);
    const answered = tui.frame();
    expect(answered).toContain("$200");
    expect(answered).not.toContain("-$880");
  });

  test("filing detail owns refresh requests and backspace returns to filings", async () => {
    const urls: string[] = [];
    installAlpha13FTransport(urls);

    await act(async () => {
      await tui.render(<Harness />, { width: 100, height: 24 });
    });
    await renderFrames();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);

    const detailFrame = tui.frame();
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

    const filingsFrame = tui.frame();
    expect(filingsFrame).toContain("PERIOD");
    expect(filingsFrame).toContain("Restatement");
    expect(filingsFrame).toContain("Back Alpha Capital");
    expect(filingsFrame).not.toContain("Accession");
  });
  test("back from an overlap keeps the first fund open and returns to the second fund picker", async () => {
    installAlpha13FTransport();
    await act(async () => { await tui.render(<Harness />, { width: 110, height: 26 }); });
    await renderFrames();
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await tui.setup().mockInput.typeText("0000000001"); });
    await renderFrames(2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await renderFrames(4);
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    expect(tui.frame()).toContain("SECOND %");
    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);
    const frame = tui.frame();
    expect(frame).toContain("Back Alpha Capital");
    expect(frame).toContain("Overlap");
    expect(frame).not.toContain("SECOND %");
  });

  test("a covered ETF's ticker in the overlap search compares the fund with the ETF's holdings file", async () => {
    // Alpha Capital holds AAPL and MSFT shares, 60 and 40; the IVV file holds them at 7% and 6%, NVDA at 7% and cash for the rest.
    const member = (id: string, symbol: string | null, weight: number) => ({
      id, symbol, name: symbol ?? "Cash", sector: null, weight, shares: 1, holdingPrice: 1, marketValue: weight, price: null, priceAsOf: null,
      changePercent: null, dailyAsOf: null, return1WPercent: null, return1MPercent: null, returnYtdPercent: null, contribution: null, stale: false,
    });
    const fund = { ticker: "IVV", name: "iShares Core S&P 500", aliases: ["SPY", "SPX"], changes: "sp500" };
    installAlpha13FTransport([], (path, parsed) => {
      if (path.endsWith("/cloud/members")) return json({ funds: [{ ...fund, asOf: "2026-05-14" }] });
      if (path.endsWith("/cloud/members/IVV")) return json({
        fund, asOf: "2026-05-14T00:00:00Z", fetchedAt: "2026-05-14T00:00:00Z", excludedDerivatives: 0, stale: false, quotesUnavailable: false,
        snapshotAsOf: null, fundDailyAsOf: null, quoteCap: 0,
        members: [member("aapl", "AAPL", 7), member("msft", "MSFT", 6), member("nvda", "NVDA", 7), member("cash", null, 80)],
        aggregate: { sum: 0, fundReturn: null, residual: null, tolerancePp: 0, withinTolerance: null, covered: 0, total: 4, coveredWeight: 0, holdingsWeight: 100, fresh1D: 0 },
      });
      if (path.endsWith("/form")) return json([["Apple Inc.", "037833100", "AAPL", 60], ["Microsoft Corp", "594918104", "MSFT", 40]].map(([issuer, cusip, ticker, value]) => ({
        cik: "0000000001", accession_number: parsed.searchParams.get("accession_number"), name_of_issuer: issuer, title_of_class: "COM", cusip, ticker,
        value, ssh_prnamt: 10, ssh_prnamt_type: "SH", investment_discretion: "SOLE", voting_authority_sole: 10, voting_authority_shared: 0, voting_authority_none: 0,
      })));
      return null;
    });
    await act(async () => { await tui.render(<Harness />, { width: 110, height: 26 }); });
    await renderFrames();
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await tui.setup().mockInput.typeText("SPY"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await renderFrames(4);
    // Offered above the managers, by the ticker asked for and the file it reads.
    expect(tui.frame()).toContain("SPY · iShares Core S&P 500 holdings");
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    const frame = tui.frame();
    expect(frame).toContain("SPY holdings");
    expect(frame).toContain("IVV file");
    expect(frame).toMatch(/Overlap\s+13\.0%\s+active share 87\.0%/);
    expect(frame).toMatch(/AAPL\s+Apple Inc\.\s+60\.0%\s+7\.00%\s+7\.00%/);
    expect(frame).toContain("SPY %");
    // Back returns to the picker, the fund still open.
    await emitKeypress({ name: "backspace", sequence: "\u007f" });
    await renderFrames(2);
    expect(tui.frame()).toContain("Back Alpha Capital");
    expect(tui.frame()).not.toContain("SPY %");
  }, 20_000);

  test("slash in a fund opened from a ticker query reaches the overlap search", async () => {
    installAlpha13FTransport();
    await act(async () => { await tui.render(<Harness />, { width: 110, height: 26 }); });
    await renderFrames();
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await tui.setup().mockInput.typeText("AAPL"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    await renderFrames(4);
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderFrames(2);
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderFrames(6);
    expect(tui.frame()).toContain("Back Alpha Capital");
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "right", sequence: "\u001B[C" });
    await renderFrames(2);
    await emitKeypress({ name: "/", sequence: "/" });
    await act(async () => { await tui.setup().mockInput.typeText("0000000009"); });
    await renderFrames(2);
    expect(tui.frame()).toContain("0000000009");
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
      await act(async () => { await tui.render(<ResearchHarness />, { width: 100, height: 26 }); });
      await renderFrames(6);
      await emitKeypress({ name: "enter", sequence: "\r" });
      await renderFrames(6);
      expect(tui.frame()).toContain("Back Alpha Capital");

      await emitKeypress({ name: "l", sequence: "l" });
      await renderFrames(2);
      const filings = tui.frame();
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
