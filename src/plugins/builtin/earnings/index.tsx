import { useCallback, useMemo } from "react";
import { usePaneFooter } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { usePaneInstance } from "../../../state/app/context";
import { parseTickerListInput, formatTickerListInput } from "../../../tickers/list";
import { usePluginAppActions, usePluginTickerActions } from "../../runtime";
import { useUiCapabilities } from "../../../ui";
import type {
  PaneSettingsContext,
  PaneSettingsDef,
  PaneTemplateCreateOptions,
} from "../../../types/plugin";
import { attachEarningsCalendarPersistence, resetEarningsCalendarPersistence } from "./data/cache";
import { attachEarningsCloudCaches, resetEarningsCloudCaches } from "./client";
import { EarningsBoard } from "./board";
import { EarningsHistoryView } from "./history";
import { earningsBoardHeadless, earningsCalendarHeadless } from "./headless";
import { scopedSymbolsFromSettings } from "./model";

/** `ERN <ticker>`: that company's reports, with the footer's ways into its other panes. */
function TickerEarnings({ symbol, focused, width, height }: { symbol: string; focused: boolean; width: number; height: number }) {
  const { navigateTicker } = usePluginTickerActions();
  const { createPaneFromTemplate } = usePluginAppActions();
  const open = useCallback((templateId: string) => createPaneFromTemplate(templateId, { symbol }), [createPaneFromTemplate, symbol]);
  // t, e, c and a are footer hints, which bind their own keys.
  usePaneFooter("earnings-actions", () => ({
    order: 10,
    hints: [
      { id: "ticker", key: "t", label: "icker", onPress: () => navigateTicker(symbol) },
      { id: "estimates", key: "e", label: "stimates", onPress: () => open("earnings-estimates-pane") },
      { id: "calls", key: "c", label: "alls", onPress: () => open("earnings-calls-pane") },
      { id: "analysts", key: "a", label: "nalysts", onPress: () => open("analyst-research-pane") },
    ],
  }), [navigateTicker, open, symbol]);
  return <EarningsHistoryView symbol={symbol} width={width} height={height} focused={focused} registrationId="earnings-history" />;
}

function EarningsPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  const { nativePaneChrome } = useUiCapabilities();
  const symbols = useMemo(() => scopedSymbolsFromSettings(pane?.settings), [pane?.settings]);
  // EVTS is always the market board; its ticker only picks the row.
  const board = pane?.settings?.board === true;
  const highlight = typeof pane?.settings?.highlight === "string" ? pane.settings.highlight : null;
  const bodyHeight = Math.max(3, height - (nativePaneChrome ? 1 : 0));
  return !board && symbols.length === 1
    ? <TickerEarnings symbol={symbols[0]!} focused={focused} width={width} height={bodyHeight} />
    : <EarningsBoard scopedSymbols={board ? [] : symbols} highlight={highlight} focused={focused} width={width} height={bodyHeight} />;
}

/** Tickers named on the command bar or the CLI. */
function earningsScopeSymbols(options: PaneTemplateCreateOptions | undefined): string[] {
  if (options?.symbols && options.symbols.length > 0) return options.symbols;
  const raw = options?.arg?.trim() ?? "";
  if (!raw) return [];
  try {
    return parseTickerListInput(raw);
  } catch {
    return [];
  }
}

/** The pane's tickers live in its settings, so they are editable there too. */
function earningsSettings(context: PaneSettingsContext): PaneSettingsDef {
  const symbols = scopedSymbolsFromSettings(context.settings);
  return {
    title: "Earnings Scope",
    values: { symbolsText: symbols.length > 0 ? formatTickerListInput(symbols) : "" },
    fields: [
      {
        key: "symbolsText",
        label: "Tickers",
        description: "Leave empty for the market's report days.",
        type: "text",
        placeholder: "AAPL, MSFT",
        clearOnChange: ["symbols"],
      },
    ],
  };
}

export const earningsModule: PluginModule = {
  setup(ctx) {
    attachEarningsCalendarPersistence(ctx.persistence);
    attachEarningsCloudCaches(ctx.persistence);
  },

  dispose() {
    resetEarningsCalendarPersistence();
    resetEarningsCloudCaches();
  },

  panes: [
    {
      id: "earnings-calendar",
      name: "Earnings Calendar",
      icon: "$",
      component: EarningsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 28 },
      tableExport: true,
      settings: earningsSettings,
    },
  ],

  paneTemplates: [
    {
      id: "earnings-calendar-pane",
      paneId: "earnings-calendar",
      label: "Earnings Calendar",
      description: "The market's report days with implied and past moves; with a ticker, its report history.",
      keywords: ["earn", "earnings", "calendar", "implied move", "surprise", "eps", "revenue", "quarterly"],
      // ERN works on the loaded security: typed alone it takes the active
      // ticker, and with none active it opens the market's report days.
      shortcut: { prefix: "ERN", argPlaceholder: "tickers", argKind: "ticker-list", argOptional: true, openWithoutArg: true },
      headless: earningsCalendarHeadless,
      canCreate: () => true,
      // Tickers named on the command bar scope the pane; without them it is the market board.
      createInstance: (_context, options) => {
        const symbols = earningsScopeSymbols(options);
        return {
          title: symbols.length > 0 ? `ERN ${formatTickerListInput(symbols)}` : "Earnings Calendar",
          placement: "floating",
          settings: symbols.length > 0 ? { symbols, symbolsText: formatTickerListInput(symbols) } : undefined,
        };
      },
    },
    {
      id: "earnings-board-pane",
      paneId: "earnings-calendar",
      label: "Earnings Days",
      description: "The market's report days with implied and past moves; a ticker picks its row.",
      keywords: ["evts", "events", "earnings calendar", "earnings season", "reporting today"],
      // Bloomberg's calendar: the market board always, never one company's history.
      shortcut: { prefix: "EVTS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
      headless: earningsBoardHeadless,
      canCreate: () => true,
      createInstance: (_context, options) => {
        const symbol = (options?.symbol ?? options?.ticker?.metadata.ticker ?? options?.arg ?? "").trim().toUpperCase();
        return {
          title: "Earnings Calendar",
          placement: "floating",
          settings: { board: true, ...(symbol ? { highlight: symbol } : {}) },
        };
      },
    },
  ],
};
