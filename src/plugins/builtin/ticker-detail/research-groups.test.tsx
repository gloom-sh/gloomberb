import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, appReducer, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { TickerResearchTabDef } from "../../../types/plugin";
import { createTestTicker } from "../../../test-support/ticker";
import { createTestPaneConfig } from "../../../test-support/pane";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { PluginRenderProvider } from "../../runtime";
import { researchEntryFromSearch } from "../../../renderers/browser/research-entry";
import { optionPaneState } from "../../../cli/pane-functions/options";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import type { AppAction, AppState } from "../../../state/app/context";
import { tickerDetailModule } from ".";
import { TICKER_RESEARCH_BUILTIN_TABS } from "./research-tabs";
import { PHARMA_SIGNALS_TAB_ID } from "./pharma-signals/eligibility";

const PANE_ID = "ticker-research:groups";
const tui = createOpenTuiTestHarness();
const runtime = createTestPluginRuntime();
/** Past the pane's 120ms commit of a tab change. */
const COMMIT_MS = 160;
let paneState: Record<string, unknown> = {};
let dispatchApp: ((action: AppAction) => void) | null = null;
let appState: AppState | null = null;

const DetailPane = tickerDetailModule.panes![0]!.component as (props: {
  paneId: string; paneType: string; focused: boolean; width: number; height: number;
}) => ReactElement;

/** Each view draws its own id, so the body says which one is shown. */
function stubTab(id: string, name: string, order: number): TickerResearchTabDef {
  return { id, name, order, component: () => <text>{`body:${id}`}</text>, isVisible: ({ ticker }) => !!ticker };
}

function useRegistry(tabs: TickerResearchTabDef[]): void {
  setSharedRegistryForTests({ tickerResearchTabs: new Map(tabs.map((tab) => [tab.id, tab])) } as unknown as PluginRegistry);
}

const US_EQUITY_TABS = [
  stubTab("overview", "Overview", 10),
  stubTab("chart", "Chart", 30),
  stubTab("sec", "SEC", 45),
  stubTab("filing-events", "8-K", 37),
  stubTab("risk-factors", "Risks", 36),
  stubTab("holders", "Holders", 42),
  stubTab("short-interest", "Short Interest", 36),
  stubTab("news", "News", 40),
];

function Harness({ state, settings, symbol = "AAPL", symbols = [symbol] }: {
  state: Record<string, unknown>;
  settings?: Record<string, unknown>;
  symbol?: string;
  /** Saved tickers, for a pane switched from one to another. */
  symbols?: string[];
}) {
  const config = createTestPaneConfig("/tmp/gloomberb-test", {
    instanceId: PANE_ID,
    paneId: TICKER_RESEARCH_PANE_ID,
    binding: { kind: "fixed", symbol },
    ...(settings ? { settings } : {}),
  });
  const initial = createInitialState(config);
  initial.focusedPaneId = PANE_ID;
  initial.tickers = new Map(symbols.map((entry) => [entry, createTestTicker(entry)]));
  initial.paneState[PANE_ID] = state;
  const [app, dispatch] = useReducer(appReducer, initial);
  paneState = app.paneState[PANE_ID] ?? {};
  appState = app;
  dispatchApp = (action) => act(() => dispatch(action));
  return (
    <AppContext value={createStaticAppStore(app, dispatch)}>
      <PaneInstanceProvider paneId={PANE_ID}>
        <PluginRenderProvider pluginId="ticker-research" runtime={runtime}>
          <DetailPane paneId={PANE_ID} paneType={TICKER_RESEARCH_PANE_ID} focused width={100} height={20} />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function render(state: Record<string, unknown>, settings?: Record<string, unknown>, tickers?: { symbol: string; symbols: string[] }): Promise<string> {
  await tui.render(<Harness state={state} settings={settings} {...tickers} />, { width: 100, height: 20 });
  await act(async () => { await tui.setup().renderOnce(); });
  return tui.frame();
}

async function press(key: string): Promise<string> {
  await act(async () => {
    tui.setup().mockInput.pressKey(key);
    await new Promise((resolve) => setTimeout(resolve, COMMIT_MS));
    await tui.setup().renderOnce();
  });
  await act(async () => { await tui.setup().renderOnce(); });
  return tui.frame();
}

/** Draws what a dispatch changed. */
async function redraw(): Promise<string> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, COMMIT_MS));
    await tui.setup().renderOnce();
  });
  await act(async () => { await tui.setup().renderOnce(); });
  return tui.frame();
}

afterEach(() => {
  setSharedRegistryForTests(undefined);
  paneState = {};
  dispatchApp = null;
  appState = null;
});

describe("Ticker Research groups", () => {
  // Every route that names a view by its old tab id opens that view inside its group.
  const entries: Array<{ name: string; state: Record<string, unknown>; settings?: Record<string, unknown> }> = [
    { name: "a saved layout", state: { activeTabId: "risk-factors" } },
    { name: "a ?tab= link", state: { activeTabId: researchEntryFromSearch("?ticker=AAPL&tab=risk-factors")!.tab } },
    { name: "gloom fn DES --tab", state: optionPaneState({ tab: "risk-factors" }) },
  ];
  for (const entry of entries) {
    test(`${entry.name} opens Risks inside Filings, with Filings' views as choices`, async () => {
      useRegistry(US_EQUITY_TABS);
      const frame = await render(entry.state, entry.settings);
      expect(frame).toContain("body:risk-factors");
      const lines = frame.split("\n");
      expect(lines[0]).toContain("Filings");
      expect(lines[0]).not.toContain("Risks");
      // The choices, most used first within the group's order.
      expect(lines[1]).toMatch(/SEC\s+8-K\s+Risks/);
      expect(paneState.activeTabId).toBe("risk-factors");
    });
  }

  test("a view renamed apart from its group still opens by its former name", async () => {
    useRegistry([...US_EQUITY_TABS, stubTab("analyst-research", "Coverage", 32), stubTab("earnings-calls", "Calls", 34)]);
    const frame = await render(optionPaneState({ tab: "analyst" }));
    expect(frame).toContain("body:analyst-research");
    const lines = frame.split("\n");
    expect(lines[0]).toContain("Analysts");
    expect(lines[1]).toMatch(/Coverage\s+Calls/);
    expect(frame).not.toContain("No such tab");
  });

  test("a pane locked to an old tab id shows that view alone, with no strips", async () => {
    useRegistry(US_EQUITY_TABS);
    const frame = await render({ activeTabId: "overview" }, { hideTabs: true, lockedTabId: "risk-factors" });
    expect(frame).toContain("body:risk-factors");
    expect(frame).not.toContain("Filings");
    expect(frame).not.toContain("8-K");
  });

  test("a group with one view opens it with no choices, and a group with none is left out", async () => {
    // A listing with SEC filings but no 8-K or risk factors, and no ownership views at all.
    useRegistry([stubTab("overview", "Overview", 10), stubTab("sec", "SEC", 45), stubTab("news", "News", 40)]);
    const frame = await render({ activeTabId: "sec" });
    const lines = frame.split("\n");
    expect(lines[0]).toMatch(/Overview\s+Filings\s+Buzz/);
    expect(frame).not.toContain("Ownership");
    expect(frame).not.toContain("SEC");
    // The view starts on the row under the strip: no choice row.
    expect(lines[1]).toContain("body:sec");
  });

  test("h and l move between groups, and a group opens on the view last chosen in it", async () => {
    useRegistry(US_EQUITY_TABS);
    await render({ activeTabId: "risk-factors" });

    let frame = await press("l");
    expect(paneState.activeTabId).toBe("holders");
    expect(frame.split("\n")[1]).toMatch(/Holders\s+Short Interest/);

    frame = await press("h");
    expect(paneState.activeTabId).toBe("risk-factors");
    expect(frame).toContain("body:risk-factors");

    // A group never chosen in opens on its first view.
    await press("h");
    expect(paneState.activeTabId).toBe("chart");
  });
  // The tab shows once the profile says drug developer, so a saved or linked
  // Signals must outlive the profile's load and a switch to another ticker.
  test("a saved Signals waits for the profile, opens inside Events, and follows the ticker", async () => {
    const signals = TICKER_RESEARCH_BUILTIN_TABS.find((tab) => tab.id === PHARMA_SIGNALS_TAB_ID)!;
    useRegistry([
      ...US_EQUITY_TABS,
      stubTab("catalysts", "Catalysts", 35),
      { ...signals, component: () => <text>{`body:${PHARMA_SIGNALS_TAB_ID}`}</text> },
    ]);
    const saved = { activeTabId: researchEntryFromSearch(`?ticker=VKTX&tab=${PHARMA_SIGNALS_TAB_ID}`)!.tab };
    let frame = await render(saved, undefined, { symbol: "VKTX", symbols: ["VKTX", "AAPL"] });
    // No profile yet: Overview shows, the saved tab stays saved.
    expect(frame).toContain("body:overview");
    expect(frame).not.toContain("Signals");
    expect(paneState.activeTabId).toBe(PHARMA_SIGNALS_TAB_ID);

    const company = (industry: string) => createTestFinancials({
      quote: createTestQuote({ instrumentType: "EQUITY" }),
      profile: { sector: industry === "Biotechnology" ? "Healthcare" : "Technology", industry },
    });
    dispatchApp!({ type: "HYDRATE_FINANCIALS", financials: new Map([["VKTX", company("Biotechnology")], ["AAPL", company("Consumer Electronics")]]) });
    frame = await redraw();
    expect(frame).toContain(`body:${PHARMA_SIGNALS_TAB_ID}`);
    const lines = frame.split("\n");
    expect(lines[0]).toContain("Events");
    expect(lines[1]).toMatch(/Catalysts\s+Signals/);

    // Another company: no Signals, and nothing of it left on screen; the saved tab waits.
    const showTicker = (symbol: string) => dispatchApp!({
      type: "UPDATE_LAYOUT",
      layout: {
        ...appState!.config.layout,
        instances: appState!.config.layout.instances.map((instance) => (
          instance.instanceId === PANE_ID ? { ...instance, binding: { kind: "fixed" as const, symbol } } : instance
        )),
      },
    });
    showTicker("AAPL");
    frame = await redraw();
    expect(frame).not.toContain("Signals");
    expect(frame).not.toContain(`body:${PHARMA_SIGNALS_TAB_ID}`);
    expect(paneState.activeTabId).toBe(PHARMA_SIGNALS_TAB_ID);

    showTicker("VKTX");
    frame = await redraw();
    expect(frame).toContain(`body:${PHARMA_SIGNALS_TAB_ID}`);
  });
});
