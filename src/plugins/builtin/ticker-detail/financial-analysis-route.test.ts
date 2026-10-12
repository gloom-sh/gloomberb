import { expect, test } from "bun:test";
import { buildPaneShortcutItems } from "../../../components/command-bar/pane-templates/items";
import { parseRootShortcutIntent } from "../../../components/command-bar/routes/root/shortcuts";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneTemplateContext } from "../../../types/plugin";
import { tickerDetailModule } from "./index";
import { buildVisibleTickerResearchTabs, includeLockedFinancialsTab } from "./settings";
import { TICKER_RESEARCH_BUILTIN_TABS } from "./research-tabs";

const financialAnalysisTemplate = tickerDetailModule.paneTemplates?.find((template) => template.id === "financial-analysis-pane");

test("FA opens locked Ticker Research Financials while remaining hidden from browse rows", async () => {
  expect(financialAnalysisTemplate).toBeDefined();
  if (!financialAnalysisTemplate) throw new Error("Financial Analysis shortcut template is missing");

  expect(financialAnalysisTemplate.paneId).toBe(TICKER_RESEARCH_PANE_ID);
  expect(financialAnalysisTemplate.shortcut).toMatchObject({ prefix: "FA", showInBrowse: false });
  expect(buildPaneShortcutItems({
    templates: [financialAnalysisTemplate],
    createItem: (template) => ({ id: template.id }) as never,
  })).toEqual([]);

  const intent = parseRootShortcutIntent({
    query: "FA AAPL",
    commands: [],
    pluginCommands: [],
    paneTemplates: [financialAnalysisTemplate],
    activeTicker: null,
  });
  expect(intent).toMatchObject({ kind: "complete", source: "pane-template", argText: "AAPL" });

  const context = {
    config: {} as never,
    layout: { instances: [] } as never,
    focusedPaneId: null,
    activeTicker: null,
    activeCollectionId: null,
  } satisfies Partial<PaneTemplateContext> as PaneTemplateContext;
  const instance = await financialAnalysisTemplate.createInstance?.(context, { arg: "AAPL" });
  expect(instance).toMatchObject({
    instanceId: "ticker-research:AAPL",
    title: "FA AAPL",
    binding: { kind: "fixed", symbol: "AAPL" },
    settings: { hideTabs: true, lockedTabId: "financials" },
    params: { tab: "financials" },
  });
  expect(instance?.params?.tabAt).toMatch(/^\d+$/);

  const ticker = { metadata: { ticker: "AAPL" } } as never;
  const visibleTabs = buildVisibleTickerResearchTabs(
    TICKER_RESEARCH_BUILTIN_TABS,
    ticker,
    null,
    { config: {} as never, hasOptionsChain: false },
  );
  expect(visibleTabs).not.toContainEqual({ id: "financials", name: "Financials", order: 20 });
  expect(includeLockedFinancialsTab(
    visibleTabs,
    TICKER_RESEARCH_BUILTIN_TABS,
    { hideTabs: false, lockedTabId: "financials" },
  )).not.toContainEqual({ id: "financials", name: "Financials", order: 20 });
});
