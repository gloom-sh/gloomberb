import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestTicker } from "../../../test-support/ticker";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { createDefaultConfig } from "../../../types/config";
import type { TickerFinancials } from "../../../types/financials";
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
const foreignEquity = [...common, "analyst-research", "equity-diagnostic", "corporate-actions", "earnings-calls", "options", "catalysts", "mna", "jobs", "hiring-momentum", "app-attention", "dividend-yield", "holders"];
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
  { label: "7203.T foreign equity", ticker: createTestTicker("7203.T", "Toyota", { exchange: "JPX", currency: "JPY" }), financials: quoted("EQUITY"), kind: "equity", visible: foreignEquity },
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

test("research visibility follows instrument and listing rules without hiding available fund or plugin research", async () => {
  const config = createDefaultConfig(":memory:");
  const tabs: TickerResearchTabDef[] = [];
  // Collect shipping definitions without booting the catalog or reading data.
  // Notes and Thesis subscribe during setup, so keep their collection signed out.
  const signedOut = spyOn(apiClient, "isVerified").mockReturnValue(false);
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
  const started: PluginModule[] = [];
  try {
    for (const module of modules) {
      started.push(module);
      await module.setup?.(context as GloomPluginContext);
    }
    tabs.push({ id: "external", name: "External", order: 100, component: () => null });
    for (const scenario of scenarios) {
      expect(resolveTickerInstrumentKind(scenario.ticker, scenario.financials), scenario.label).toBe(scenario.kind);
      const visible = buildVisibleTickerResearchTabs(tabs, scenario.ticker, scenario.financials, {
        config,
        hasOptionsChain: scenario.hasOptionsChain ?? true,
      });
      expect(visible.map((tab) => tab.id).sort(), scenario.label).toEqual([...scenario.visible].sort());
    }
  } finally {
    for (const module of started.reverse()) module.dispose?.();
    signedOut.mockRestore();
  }
});
