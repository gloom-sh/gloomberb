import type { PaneSettingsDef, TickerResearchTabDef } from "../../../types/plugin";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { AppConfig } from "../../../types/config";
import type { PriceSparklinePeriod } from "../../../components/price-sparkline/view";
import { getSharedRegistry } from "../../registry";
import { formatTickerListInput, MAX_TICKER_LIST_SIZE, parseTickerListInput } from "../../../tickers/list";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";

type TickerResearchTabSummary = { id: string; name: string; order: number };

export interface TickerResearchPaneSettings {
  hideTabs: boolean;
  lockedTabId: string;
}

export interface QuoteMonitorPaneSettings {
  symbols: string[];
  symbolsText: string;
  chartPeriod: PriceSparklinePeriod;
}

const DEFAULT_QUOTE_MONITOR_CHART_PERIOD: PriceSparklinePeriod = "1M";

export function getTickerResearchPaneSettings(
  settings: Record<string, unknown> | undefined,
): TickerResearchPaneSettings {
  return {
    hideTabs: settings?.hideTabs === true,
    lockedTabId: settings?.lockedTabId === "fundamental-graphs"
      ? "chart"
      : typeof settings?.lockedTabId === "string" ? settings.lockedTabId : "overview",
  };
}

export function resolveLockedTabId(
  settings: TickerResearchPaneSettings,
  tabs: TickerResearchTabSummary[],
): string {
  if (tabs.some((tab) => tab.id === settings.lockedTabId)) {
    return settings.lockedTabId;
  }
  return tabs[0]?.id ?? "overview";
}

function getAvailableSettingsTabs(): TickerResearchTabSummary[] {
  const registry = getSharedRegistry();
  const pluginTabs = registry
    ? [...registry.tickerResearchTabs.values()].map((tab) => ({ id: tab.id, name: tab.name, order: tab.order }))
    : [];

  return pluginTabs
    .sort((left, right) => left.order - right.order)
    .filter((tab, index, allTabs) => allTabs.findIndex((candidate) => candidate.id === tab.id) === index);
}

export function buildTickerResearchSettingsDef(settings: TickerResearchPaneSettings): PaneSettingsDef {
  const tabs = getAvailableSettingsTabs();

  return {
    title: "Ticker Research Settings",
    fields: [
      {
        key: "hideTabs",
        label: "Hide Tabs",
        description: "Hide Ticker Research tabs and lock this pane to one view.",
        type: "toggle" as const,
      },
      ...(settings.hideTabs
        ? [{
          key: "lockedTabId",
          label: "Locked Tab",
          type: "select" as const,
          options: tabs.map((tab) => ({ value: tab.id, label: tab.name })),
        }]
        : []),
      {
        key: "chainRefreshMinutes",
        label: "Options chain refresh",
        description: "How often the Options tab refetches the whole chain snapshot.",
        type: "select" as const,
        options: [
          { value: "1", label: "Every minute" },
          { value: "5", label: "Every 5 minutes" },
          { value: "10", label: "Every 10 minutes" },
          { value: "30", label: "Every 30 minutes" },
        ],
      },
    ],
  };
}

function coerceQuoteMonitorSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const parsed = value.filter((entry): entry is string => typeof entry === "string");
  try {
    return parseTickerListInput(parsed.join(", "), MAX_TICKER_LIST_SIZE);
  } catch {
    return parsed.slice(0, MAX_TICKER_LIST_SIZE);
  }
}

export function buildQuoteMonitorPaneTitle(symbols: string[]): string {
  if (symbols.length === 0) return "Quote Monitor";
  if (symbols.length <= 3) return symbols.join(" · ");
  return `${symbols.slice(0, 2).join(" · ")} +${symbols.length - 2}`;
}

export function getQuoteMonitorPaneSettings(
  settings: Record<string, unknown> | undefined,
  fallbackSymbol?: string | null,
): QuoteMonitorPaneSettings {
  const storedSymbols = coerceQuoteMonitorSymbols(settings?.symbols);
  const legacySymbol = typeof settings?.symbol === "string" ? settings.symbol.trim() : "";
  const storedText = typeof settings?.symbolsText === "string" ? settings.symbolsText : "";
  let symbols = storedSymbols;

  if (symbols.length === 0 && storedText.trim().length > 0) {
    try {
      symbols = parseTickerListInput(storedText, MAX_TICKER_LIST_SIZE);
    } catch {
      symbols = [];
    }
  }
  if (symbols.length === 0 && legacySymbol) {
    try {
      symbols = parseTickerListInput(legacySymbol, MAX_TICKER_LIST_SIZE);
    } catch {
      symbols = [legacySymbol.toUpperCase()];
    }
  }
  if (symbols.length === 0 && fallbackSymbol) {
    symbols = [fallbackSymbol.toUpperCase()];
  }

  return {
    symbols,
    symbolsText: storedText.trim().length > 0 ? storedText : formatTickerListInput(symbols),
    chartPeriod: settings?.chartPeriod === "1D"
      || settings?.chartPeriod === "1W"
      || settings?.chartPeriod === "1M"
      || settings?.chartPeriod === "1Y"
      ? settings.chartPeriod
      : DEFAULT_QUOTE_MONITOR_CHART_PERIOD,
  };
}

export function buildQuoteMonitorSettingsDef(settings: Record<string, unknown> | undefined): PaneSettingsDef {
  return {
    title: "Quote Monitor Settings",
    values: {
      chartPeriod: getQuoteMonitorPaneSettings(settings).chartPeriod,
    },
    fields: [
      {
        key: "symbolsText",
        label: "Tickers",
        description: `Enter up to ${MAX_TICKER_LIST_SIZE} tickers separated by commas.`,
        type: "text",
        placeholder: "AAPL, MSFT, NVDA",
      },
      {
        key: "chartPeriod",
        label: "Chart Period",
        description: "Set the period used for quote sparklines and range labels.",
        type: "select",
        options: [
          { value: "1D", label: "1D" },
          { value: "1W", label: "1W" },
          { value: "1M", label: "1M" },
          { value: "1Y", label: "1Y" },
        ],
      },
    ],
  };
}

export function buildVisibleTickerResearchTabs(
  pluginTabs: TickerResearchTabDef[],
  ticker: TickerRecord | null,
  financials: TickerFinancials | null | undefined,
  options: {
    config: AppConfig;
    hasOptionsChain: boolean;
  },
): TickerResearchTabSummary[] {
  const tabs: TickerResearchTabSummary[] = [];
  const instrumentKind = resolveTickerInstrumentKind(ticker, financials);

  for (const tab of pluginTabs) {
    if (tab.instruments && !tab.instruments.includes(instrumentKind)) continue;
    if (tab.isVisible && !tab.isVisible({
      config: options.config,
      ticker,
      financials,
      hasOptionsChain: options.hasOptionsChain,
      instrumentKind,
    })) continue;
    tabs.push({ id: tab.id, name: tab.name, order: tab.order });
  }

  return tabs.sort((left, right) => left.order - right.order);
}
