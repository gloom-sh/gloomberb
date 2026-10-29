import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer, type Dispatch } from "react";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness, takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../remote/semantic-tree";
import { apiClient } from "../../../api-client";
import type { ScreenDefinition, ScreenPayload } from "../../../api-client/equity-screener";
import { findPaneInstance } from "../../../types/config";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { PaneSettingsContext, PaneTemplateContext } from "../../../types/plugin";
import { setPaneSettings } from "../../../pane-settings";
import { screenFixture } from "../equity-screener/test-fixture";
import { RelativeValuationPane } from "./relative-valuation-pane";
import { relativeValuationHeadless } from "./relative-valuation-headless";
import { buildRelativeValuationSettingsDef } from "./relative-valuation-settings";
import { researchModule } from "./index";

const tui = createOpenTuiTestHarness();
const paneId = "relative-valuation:test";
let latest: AppState;
let dispatch: Dispatch<AppAction>;
function Harness({ width, symbols = ["PLD", "FRESH", "MISSING"], registry = createRemoteUiRegistry() }: { width: number; symbols?: string[]; registry?: RemoteUiRegistry }) {
  const config = createTestPaneConfig("/tmp/gloom-relative-valuation-test", {
    instanceId: paneId, paneId: "relative-valuation-pane", settings: { symbols },
  });
  const state = createInitialState(config);
  return <RemoteUiRegistryProvider registry={registry}><TestPaneProvider state={state} paneId={paneId} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
    <PaneFooterProvider>{(footer) => <Box width={width} height={16} flexDirection="column">
      <Box width={width} height={15}><RelativeValuationPane paneId={paneId} paneType="relative-valuation-pane" focused width={width} height={15} /></Box>
      <PaneFooterBar footer={footer} focused width={width} />
    </Box>}</PaneFooterProvider>
  </TestPaneProvider></RemoteUiRegistryProvider>;
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); await tui.setup().renderOnce(); });
}
afterEach(() => {
  setSharedMarketDataCoordinator(null);
});
test("stale peer remains inspectable with contextual failure, excluded quote values and healthy peers intact", async () => {
  let stale = true;
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getTickerFinancials: async (symbol) => {
    if (symbol === "MISSING") throw new Error("source unavailable");
    return { annualStatements: [], quarterlyStatements: [], priceHistory: [],
      quote: { symbol, price: symbol === "PLD" ? 135.75 : 200, change: 1, changePercent: 1, currency: "USD", lastUpdated: 1789167600002,
        stale: symbol === "PLD" && stale, marketCap: 1000 },
      fundamentals: { trailingPE: 30.2, operatingMargin: .4, financialCurrency: "USD" },
    };
  } })));
  await act(async () => { await tui.render(<Harness width={120} />, { width: 120, height: 16 }); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Stale quotes: PLD");
  expect(frame).toContain("MISSING: source unavailable");
  expect(frame).toContain("PLD");
  expect(frame).toContain("$200.00");
  expect(frame).not.toContain("$135.75");
  await exportPaneTable(paneId, "rv-stale.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("PLD,,,,30.2");
  stale = false;
  await act(async () => { tui.setup().mockInput.pressKey("r"); });
  await settle();
  const recovered = tui.frame();
  expect(recovered).toContain("$135.75");
  expect(recovered).not.toContain("Stale quotes:");
  expect(recovered).toContain("MISSING: source unavailable");
});

test("stale fundamentals retain their disclosure and export provenance with a fresh quote, then clear on refresh", async () => {
  let stale = true;
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getTickerFinancials: async (symbol) => ({
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: 135.75, change: 1, changePercent: 1, currency: "USD", lastUpdated: 1789567200000, stale: false, marketCap: 131e9 },
    fundamentals: { trailingPE: 30.2, financialCurrency: "USD", source: "gloom", fetchedAt: "2026-09-11T23:52:16.139Z", stale: symbol === "PLD" && stale },
  }) })));
  await tui.render(<Harness width={120} />, { width: 120, height: 16 });
  await settle();
  expect(tui.frame()).toContain("$135.75");
  expect(tui.frame()).not.toContain("Fundamentals stale");
  await act(async () => tui.setup().mockInput.pressKey("!"));
  await settle();
  expect(tui.frame()).toContain("PLD: Fundamentals stale");
  await act(async () => tui.setup().mockInput.pressKey("escape"));
  await settle();
  await exportPaneTable(paneId, "rv-stale-fundamentals.csv");
  const csv = takeSavedTextFile()!.text;
  expect(csv).toContain("PLD,Fundamentals retrieved,2026-09-11T23:52:16.139Z,Stale,true");
  expect(csv).not.toContain("gloom");
  expect(csv).toContain("PLD,Fundamentals stale");
  stale = false;
  await act(async () => tui.setup().mockInput.pressKey("r"));
  await settle();
  await act(async () => tui.setup().mockInput.pressKey("!"));
  await settle();
  expect(tui.frame()).not.toContain("Fundamentals stale");
  await exportPaneTable(paneId, "rv-fresh-fundamentals.csv");
  expect(takeSavedTextFile()!.text).toContain("PLD,Fundamentals retrieved,2026-09-11T23:52:16.139Z,Stale,false");
});

test("euro and dollar caps under MCAP USD name the rate in the footer, beside the period the figures run through, and a capture reads both", async () => {
  const quarters = [{ date: "2026-03-31" }, { date: "2026-06-30" }];
  const rateAsOf = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 3_600_000).toISOString();
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    getExchangeRateSnapshot: async (currency) => ({ fromCurrency: currency, toCurrency: "USD", rate: 1.1612, source: "test",
      asOf: rateAsOf, fetchedAt: new Date().toISOString(), stale: false }),
    getTickerFinancials: async (symbol) => {
      const euro = symbol === "LHA:XETRA";
      return { annualStatements: [{ date: "2025-12-31" }], quarterlyStatements: quarters, priceHistory: [],
        quote: { symbol, price: euro ? 7.05 : 546.97, change: 0, changePercent: 0, currency: euro ? "EUR" : "USD", lastUpdated: Date.now() - 60_000,
          exchangeName: euro ? "XETRA" : "NYSE", dataSource: "delayed" as const, providerId: "gloomberb-cloud", marketCap: euro ? 8.5e9 : 1.14e12 },
        fundamentals: { financialCurrency: euro ? "EUR" : "USD", revenueGrowth: 0.079, operatingMargin: 0.04 } };
    },
  })));
  const registry = createRemoteUiRegistry();
  await act(async () => { await tui.render(<Harness width={160} symbols={["LHA:XETRA", "BRK-B"]} registry={registry} />, { width: 160, height: 16 }); });
  await settle();
  const footer = `MCAP USD at EUR/USD 1.1612 (${rateAsOf.slice(0, 16).replace("T", " ")} UTC) · fundamentals through 2026-06-30, Q REV% for that quarter`;
  expect(tui.frame()).toContain(footer);
  // A capture's status line ends with the same words, after each market's session, from what the pane publishes.
  const published = registry.snapshot().find((node) => node.role === "report-freshness")?.metadata;
  const shorter = "MCAP USD at EUR/USD 1.1612 · fundamentals through 2026-06-30, Q REV% for that quarter";
  expect(published).toMatchObject({ datesEachVenue: true, note: footer, noteVariants: [shorter, "MCAP USD at EUR/USD 1.1612 · fundamentals through 2026-06-30", "MCAP USD at EUR/USD 1.1612"] });
  expect((published?.observations as Array<Record<string, unknown>>).map((row) => row.delayMinutes)).toEqual([15, 15]);
  // A narrow pane keeps the rate and the period, without the rate's time.
  await act(async () => { await tui.render(<Harness width={80} symbols={["LHA:XETRA", "BRK-B"]} />, { width: 80, height: 16 }); });
  await settle();
  expect(tui.frame()).toContain("MCAP USD at EUR/USD 1.1612 · fundamentals through 2026-06-30 ");
});

test("a peer whose trailing quarters are not in yet shows its latest fiscal year's margin, named, and the column widens to fit", async () => {
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getTickerFinancials: async (symbol) => ({
    annualStatements: symbol === "CCL" ? [{ date: "2025-11-30", totalRevenue: 26.62e9, operatingIncome: 4.48e9 }] : [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: 26, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1789167600002, marketCap: 35e9 },
    fundamentals: { financialCurrency: "USD", ...symbol === "CCL" ? {} : { operatingMargin: 0.2732 } },
  }) })));
  await act(async () => { await tui.render(<Harness width={140} symbols={["CCL", "RCL"]} />, { width: 140, height: 16 }); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("16.83% FY25");
  expect(frame).toContain("27.32%");
});

const LEARNING = "Duolingo, Inc. is a technology company focused on language learning and digital education.";

function screenRow(symbol: string, cap: number): ScreenPayload["rows"][number] {
  const row = structuredClone(screenFixture().rows[0]!);
  row.metrics.marketCap = { ...row.metrics.marketCap, value: cap, state: "available", asOf: "2026-10-27" };
  row.metrics.revenueGrowthPercent = { ...row.metrics.revenueGrowthPercent, value: 10, state: "available", asOf: "2026-10-27" };
  return { ...row, symbol, exchange: "NYSE", name: symbol, industry: "Education & Training Services" };
}

// One ticker opens on the peers `fn RV DUOL --peers` picks, by the same code and data, titled with the method.
test("RV of one ticker fills in the peers --peers picks, says how in its title, and keeps a list typed in its settings", async () => {
  const provider = createTestDataProvider({ getTickerFinancials: async (symbol) => ({
    annualStatements: [], quarterlyStatements: [], priceHistory: [],
    quote: { symbol, price: 100, change: 0, changePercent: 0, currency: "USD", lastUpdated: 1789167600002, marketCap: symbol === "DUOL" ? 6.5e9 : 2e9 },
    fundamentals: { financialCurrency: "USD" },
    profile: { industry: "Software - Application", description: LEARNING },
  }) });
  setSharedMarketDataCoordinator(new MarketDataCoordinator(provider));
  const screened: string[] = [];
  const screener = spyOn(apiClient, "equityScreener").mockImplementation((async (_path: string, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)) as ScreenDefinition & { limit: number; cursor: null };
    const criterion = query.criteria[0]!;
    screened.push(String(criterion.field));
    const rows = criterion.field === "industry"
      ? [screenRow("LAUR", 5.4e9), screenRow("CVSA", 4.4e9), screenRow("LRN", 3.4e9), screenRow("COUR", 1.4e9)]
      : [screenRow("DUOL", 6.5e9), screenRow("COUR", 1.4e9), screenRow("NRDY", 4.4e8), screenRow("LRN", 3.4e9)];
    const { limit: _limit, cursor: _cursor, ...definition } = query;
    return { ...screenFixture(), definition, rows };
  }) as typeof apiClient.equityScreener);
  try {
    const template = researchModule.paneTemplates!.find((entry) => entry.id === "relative-valuation-pane")!;
    const context = { activeTicker: null } as unknown as PaneTemplateContext;
    const opened = await template.createInstance!(context, { arg: "DUOL" });
    // Several tickers are compared as typed.
    expect((await template.createInstance!(context, { arg: "DUOL LRN" }))?.settings).not.toHaveProperty("autoPeers");
    const instance = { instanceId: paneId, paneId: "relative-valuation", title: opened!.title, settings: opened!.settings };
    const config = createTestPaneConfig("/tmp/gloom-relative-valuation-test", instance);
    const runtime = createTestPluginRuntime({ getMarketData: () => provider });
    function Live() {
      [latest, dispatch] = useReducer(appReducer, config, createInitialState);
      return <TestPaneProvider state={latest} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime}>
        <RelativeValuationPane paneId={paneId} paneType="relative-valuation" focused width={120} height={15} />
      </TestPaneProvider>;
    }
    await act(async () => { await tui.render(<Live />, { width: 120, height: 16 }); });
    for (let i = 0; i < 40 && !tui.frame().includes("LAUR"); i++) await settle();
    const pane = () => findPaneInstance(latest.config.layout, paneId)!;
    const report = await relativeValuationHeadless.expandArgument!(
      { symbols: ["DUOL"], argument: ["DUOL"], rawArgument: "DUOL", options: { peers: true } },
      { signal: new AbortController().signal, marketData: provider, apiClient } as unknown as HeadlessPaneContext,
    );
    expect(pane().settings?.symbols).toEqual(report!.argument.split(", "));
    expect(pane().settings?.symbols).toEqual(["DUOL", "LRN", "COUR", "NRDY", "LAUR", "CVSA"]);
    expect(pane().title).toBe(report!.title);
    expect(pane().title).toBe("RV DUOL + auto peers: online learning curated core, then Education & Training Services");
    for (const peer of ["LRN", "COUR", "NRDY", "LAUR", "CVSA"]) expect(tui.frame()).toContain(peer);

    // A list typed in the pane's settings is compared as typed, a single ticker too, and picks nothing.
    const asked = screened.length;
    const settingsDef = buildRelativeValuationSettingsDef({ settings: pane().settings ?? {} } as PaneSettingsContext);
    expect(settingsDef.fields[0]!.description).toStartWith("Peers chosen automatically: LRN, COUR and NRDY from the online learning curated core");
    const typed = await settingsDef.applyValue!(pane().settings ?? {}, settingsDef.fields[0]!, "duol", {} as PaneSettingsContext);
    await act(async () => dispatch({ type: "SET_CONFIG", config: { ...latest.config,
      layout: setPaneSettings(latest.config.layout, paneId, typed) } }));
    await settle();
    expect(pane().settings?.symbols).toEqual(["DUOL"]);
    expect(pane().title).toBe("RV DUOL");
    expect(tui.frame()).not.toContain("LAUR");
    expect(screened.length).toBe(asked);
  } finally {
    screener.mockRestore();
  }
});
