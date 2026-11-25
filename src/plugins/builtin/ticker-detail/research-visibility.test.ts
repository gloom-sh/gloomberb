import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestTicker } from "../../../test-support/ticker";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { createDefaultConfig } from "../../../types/config";
import type { CompanyProfile, TickerFinancials } from "../../../types/financials";
import type { TickerInstrumentKind } from "../../../types/instrument";
import type { GloomPluginContext, TickerResearchTabDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { catalystsModule } from "../catalysts";
import { chartComposerModule } from "../chart-composer";
import { thesisModule } from "../cloud/thesis/module";
import { cloudTweetsModule } from "../cloud-tweets";
import { companyAttentionModule } from "../company-attention";
import { congressResearchModule } from "../congress-trades";
import { dividendYieldModule } from "../dividend-yield";
import { earningsCallsModule } from "../earnings-calls";
import { executivesModule } from "../executives";
import { filingEventsModule } from "../filing-events";
import { holdersModule } from "../holders";
import { insiderModule } from "../insider";
import { jobsModule } from "../jobs";
import { mnaModule } from "../mna";
import { tickerNewsModule } from "../news";
import { notesPlugin } from "../notes";
import { optionsModule } from "../options";
import type { PluginModule } from "../plugin-module";
import { researchModule } from "../research";
import { revenueBreakdownModule } from "../revenue-breakdown";
import { riskFactorsModule } from "../risk-factors";
import { secModule } from "../sec";
import { shortInterestModule } from "../short-interest";
import { thirteenFModule } from "../thirteenf";
import { tickerDetailModule } from ".";
import { buildVisibleTickerResearchTabs } from "./settings";
import { groupTickerResearchTabs } from "./research-groups";
import { PHARMA_SIGNALS_TAB_ID } from "./pharma-signals/eligibility";

const modules: PluginModule[] = [
  tickerDetailModule, chartComposerModule, optionsModule, congressResearchModule,
  researchModule, revenueBreakdownModule, companyAttentionModule, catalystsModule,
  mnaModule, dividendYieldModule, holdersModule, shortInterestModule, thirteenFModule,
  secModule, insiderModule, jobsModule, executivesModule, riskFactorsModule,
  filingEventsModule, earningsCallsModule, tickerNewsModule, cloudTweetsModule,
  notesPlugin, thesisModule,
];

const common = ["overview", "chart", "news", "notes", "thesis", "external"];
const usFund = [...common, "corporate-actions", "options", "congress", "ticker-tweets", "dividend-yield", "thirteenf"];
const mutualFund = usFund.filter((id) => id !== "options" && id !== "thirteenf");
const foreignEquity = [...common, "analyst-research", "equity-diagnostic", "corporate-actions", "event-dividends", "earnings-calls", "options", "catalysts", "mna", "jobs", "hiring-momentum", "app-attention", "dividend-yield", "holders"];
const usEquity = [...foreignEquity, "revenue", "executives", "short-interest", "risk-factors", "filing-events", "congress", "ticker-tweets", "thirteenf", "sec", "insider"];
const withOptions = [...common, "options"];
const quoted = (instrumentType: string) => createTestFinancials({ quote: createTestQuote({ instrumentType }) });
const cached = (instrumentType: string) => createTestFinancials({ quoteMetadata: { symbol: "X", instrumentType, source: {} } });

interface Scenario {
  label: string;
  ticker: TickerRecord;
  financials?: TickerFinancials | null;
  kind: TickerInstrumentKind;
  visible: string[];
  hasOptionsChain?: boolean;
}

const scenarios: Scenario[] = [
  { label: "VFIAX mutual fund", ticker: createTestTicker("VFIAX"), financials: quoted("MUTUALFUND"), kind: "fund", visible: mutualFund },
  { label: "SPAXX money-market fund", ticker: createTestTicker("SPAXX"), financials: quoted("MONEYMARKET"), kind: "fund", visible: mutualFund },
  { label: "SPY ETF", ticker: createTestTicker("SPY", "SPY", { exchange: "ARCA" }), financials: quoted("ETF"), kind: "fund", visible: usFund },
  { label: "QQQ ETF", ticker: createTestTicker("QQQ"), financials: quoted("ETF"), kind: "fund", visible: usFund },
  { label: "AAPL equity", ticker: createTestTicker("AAPL"), financials: quoted("EQUITY"), kind: "equity", visible: usEquity },
  { label: "BRK.B share class", ticker: createTestTicker("BRK.B", "Berkshire", { exchange: "NYSE" }), financials: quoted("EQUITY"), kind: "equity", visible: usEquity },
  { label: "7203.T foreign equity", ticker: createTestTicker("7203.T", "Toyota", { exchange: "JPX", currency: "JPY" }), financials: quoted("EQUITY"), kind: "equity", visible: [...foreignEquity, "short-interest"] },
  // A symbol whose quote never loaded has no venue or currency: unknown is not foreign.
  { label: "US equity with no quote and no venue", ticker: createTestTicker("CRBG", "Corebridge", { exchange: "", currency: "" }), kind: "equity", visible: usEquity },
  // Tweets go by the saved venue alone.
  { label: "7203.T with no quote and no venue", ticker: createTestTicker("7203.T", "Toyota", { exchange: "", currency: "" }), kind: "equity", visible: [...foreignEquity, "short-interest", "ticker-tweets"] },
  { label: "BTC-USD crypto", ticker: createTestTicker("BTC-USD", "Bitcoin", { exchange: "CCC" }), financials: quoted("CRYPTOCURRENCY"), kind: "crypto", visible: common },
  { label: "^GSPC index before quote", ticker: createTestTicker("^GSPC", "S&P 500", { exchange: "SNP" }), kind: "index", visible: withOptions },
  { label: "ES=F future before quote", ticker: createTestTicker("ES=F", "S&P future", { exchange: "CME" }), kind: "future", visible: withOptions },
  { label: "EURUSD FX", ticker: createTestTicker("EURUSD", "Euro Dollar", { exchange: "CCY", assetCategory: "CASH" }), kind: "currency", visible: common },
  { label: "closed-end fund", ticker: createTestTicker("ADX"), financials: quoted("CLOSEDENDFUND"), kind: "fund", visible: usFund },
  { label: "unknown fund subtype stays available", ticker: createTestTicker("FUND", "Fund", { assetCategory: "FUND" }), kind: "fund", visible: usFund },
  { label: "option can open underlying chain", ticker: createTestTicker("AAPL 270115C00200000", "AAPL call", { exchange: "CBOE", assetCategory: "OPT" }), kind: "option", visible: withOptions },
  { label: "bond preserves ungated social tab", ticker: createTestTicker("BOND", "Bond", { exchange: "NYSE", assetCategory: "BOND" }), kind: "bond", visible: [...common, "ticker-tweets"] },
  { label: "other preserves ungated social tab", ticker: createTestTicker("WARRANT", "Warrant", { exchange: "NYSE", assetCategory: "WAR" }), kind: "other", visible: [...common, "ticker-tweets"] },
  { label: "mutual fund cached without quote", ticker: createTestTicker("VFIAX", "Fund", { assetCategory: "STK" }), financials: cached("MUTUALFUND"), kind: "fund", visible: mutualFund },
  { label: "saved mutual fund with generic broker type", ticker: createTestTicker("VFIAX", "Fund", { assetCategory: "MUTUALFUND", broker_contracts: [{ brokerId: "test", symbol: "VFIAX", secType: "STK" }] }), financials: quoted("EQUITY"), kind: "fund", visible: mutualFund },
  { label: "saved money-market alias before quote", ticker: createTestTicker("SPAXX", "Fund", { assetCategory: "money market fund" }), kind: "fund", visible: mutualFund },
  { label: "open-end structure can include ETFs", ticker: createTestTicker("OPEN", "Fund", { assetCategory: "open-end fund" }), kind: "fund", visible: usFund },
  { label: "current ETF outranks stale mutual metadata", ticker: createTestTicker("SPY", "ETF", { assetCategory: "MUTUALFUND" }), financials: { ...cached("MUTUALFUND"), quote: createTestQuote({ instrumentType: "ETF" }) }, kind: "fund", visible: usFund },
  { label: "unknown quote fund subtype stays conservative", ticker: createTestTicker("FUND", "Fund", { assetCategory: "MUTUALFUND" }), financials: quoted("FUND"), kind: "fund", visible: usFund },
  { label: "existing options target gate", ticker: createTestTicker("SPY"), financials: quoted("ETF"), kind: "fund", visible: usFund.filter((id) => id !== "options"), hasOptionsChain: false },
  { label: "existing statements remain visible for a fund", ticker: createTestTicker("VFIAX"), financials: { ...quoted("MUTUALFUND"), annualStatements: [{ date: "2025-12-31", totalAssets: 100 }] }, kind: "fund", visible: [...mutualFund, "financials"] },
];

const config = createDefaultConfig(":memory:");
const tabs: TickerResearchTabDef[] = [];
const started: PluginModule[] = [];
let signedOut: ReturnType<typeof spyOn> | null = null;

// Collect shipping definitions without booting the catalog or reading data.
// Notes and Thesis subscribe during setup, so keep their collection signed out.
beforeAll(async () => {
  signedOut = spyOn(apiClient, "isVerified").mockReturnValue(false);
  const context: Partial<GloomPluginContext> = {
    registerTickerResearchTab: (tab: TickerResearchTabDef) => { tabs.push(tab); },
    persistence: new MemoryPluginPersistence(),
    connectionHealth: new ConnectionHealthRegistry(),
    getConfig: () => config,
    registerPane() {},
    registerPaneTemplate: () => () => {},
    registerCommand() {},
    registerCommandBarSearchProvider: () => () => {},
    registerTickerAction() {},
    createPaneFromTemplate() {},
    notify() {},
    on: () => () => {},
  };
  for (const module of modules) {
    started.push(module);
    await module.setup?.(context as GloomPluginContext);
  }
  tabs.push({ id: "external", name: "External", order: 100, component: () => null });
});

afterAll(() => {
  for (const module of started.reverse()) module.dispose?.();
  signedOut?.mockRestore();
});

function visibleFor(scenario: Scenario) {
  return buildVisibleTickerResearchTabs(tabs, scenario.ticker, scenario.financials, {
    config,
    hasOptionsChain: scenario.hasOptionsChain ?? true,
  });
}

test("research visibility follows instrument and listing rules without hiding available fund or plugin research", () => {
  for (const scenario of scenarios) {
    expect(resolveTickerInstrumentKind(scenario.ticker, scenario.financials), scenario.label).toBe(scenario.kind);
    expect(visibleFor(scenario).map((tab) => tab.id).sort(), scenario.label).toEqual([...scenario.visible].sort());
  }
});

test("each asset type gets only the groups it has views for, and a one-view group is that view", () => {
  const groupsOf = (label: string) => groupTickerResearchTabs(visibleFor(scenarios.find((scenario) => scenario.label === label)!))
    .map((group) => `${group.name}: ${group.views.map((view) => view.id).join(" ")}`);
  expect(groupsOf("AAPL equity")).toEqual([
    "Overview: overview",
    "Chart: chart",
    "Financials: revenue equity-diagnostic dividend-yield",
    "Analysts: analyst-research earnings-calls",
    "Options: options",
    "Events: corporate-actions event-dividends catalysts mna",
    "Filings: sec filing-events risk-factors",
    "Ownership: holders insider thirteenf congress short-interest",
    "People: executives jobs hiring-momentum",
    "Buzz: news ticker-tweets app-attention",
    "Notes: thesis notes",
    // A plugin's own tab, after the built-in groups.
    "External: external",
  ]);
  expect(groupsOf("SPY ETF")).toEqual([
    "Overview: overview",
    "Chart: chart",
    "Financials: dividend-yield",
    "Options: options",
    "Events: corporate-actions",
    "Ownership: thirteenf congress",
    "Buzz: news ticker-tweets",
    "Notes: thesis notes",
    "External: external",
  ]);
  expect(groupsOf("7203.T foreign equity")).toEqual([
    "Overview: overview",
    "Chart: chart",
    "Financials: equity-diagnostic dividend-yield",
    "Analysts: analyst-research earnings-calls",
    "Options: options",
    "Events: corporate-actions event-dividends catalysts mna",
    "Ownership: holders short-interest",
    "People: jobs hiring-momentum",
    "Buzz: news app-attention",
    "Notes: thesis notes",
    "External: external",
  ]);
  expect(groupsOf("BTC-USD crypto")).toEqual([
    "Overview: overview",
    "Chart: chart",
    "Buzz: news",
    "Notes: thesis notes",
    "External: external",
  ]);
});

// The waitlist is for drug developers' holders: the profile decides, never the
// sector alone, the name, a fund's theme or a profile still loading.
test("Signals shows for biotech and drug makers only: not other healthcare, other industries, funds or an unread profile", () => {
  const profiled = (instrumentType: string, profile: CompanyProfile) => createTestFinancials({ quote: createTestQuote({ instrumentType }), profile });
  const cases: Array<[label: string, ticker: TickerRecord, financials: TickerFinancials | null | undefined, shown: boolean]> = [
    ["VKTX biotech", createTestTicker("VKTX"), profiled("EQUITY", { sector: "Healthcare", industry: "Biotechnology" }), true],
    ["PFE drug manufacturer", createTestTicker("PFE"), profiled("EQUITY", { sector: "Healthcare", industry: "Drug Manufacturers - General" }), true],
    ["TEVA receipt, specialty and generic drugs", createTestTicker("TEVA"), profiled("ADR", { sector: "Healthcare", industry: "Drug Manufacturers - Specialty & Generic" }), true],
    ["a US drug filer known by its SEC code", createTestTicker("CRMD"), profiled("EQUITY", { sic: "2834" }), true],
    ["ISRG medical instruments", createTestTicker("ISRG"), profiled("EQUITY", { sector: "Healthcare", industry: "Medical Instruments & Supplies" }), false],
    ["UNH healthcare plans", createTestTicker("UNH"), profiled("EQUITY", { sector: "Healthcare", industry: "Healthcare Plans" }), false],
    ["TMO diagnostics and research", createTestTicker("TMO"), profiled("EQUITY", { sector: "Healthcare", industry: "Diagnostics & Research" }), false],
    ["a diagnostics filer by SEC code", createTestTicker("DGX"), profiled("EQUITY", { sic: "2835" }), false],
    ["a drug SEC code under another industry", createTestTicker("XYZ"), profiled("EQUITY", { industry: "Specialty Chemicals", sic: "2834" }), false],
    ["AAPL consumer electronics", createTestTicker("AAPL"), profiled("EQUITY", { sector: "Technology", industry: "Consumer Electronics" }), false],
    ["XBI biotech ETF", createTestTicker("XBI"), profiled("ETF", { name: "SPDR S&P Biotech ETF" }), false],
    ["a fund whose profile names biotech", createTestTicker("BBH"), profiled("ETF", { sector: "Healthcare", industry: "Biotechnology" }), false],
    ["a drug developer whose profile has not loaded", createTestTicker("VKTX", "Viking Therapeutics, Inc."), quoted("EQUITY"), false],
    ["a drug developer with nothing loaded", createTestTicker("VKTX", "Viking Therapeutics, Inc."), undefined, false],
  ];
  for (const [label, ticker, financials, shown] of cases) {
    const visible = buildVisibleTickerResearchTabs(tabs, ticker, financials, { config, hasOptionsChain: true });
    expect(visible.some((tab) => tab.id === PHARMA_SIGNALS_TAB_ID), label).toBe(shown);
    // Beside the catalysts, the last of Events.
    if (shown) expect(groupTickerResearchTabs(visible).find((group) => group.id === "events")?.views.at(-1)?.id, label).toBe(PHARMA_SIGNALS_TAB_ID);
  }
});
