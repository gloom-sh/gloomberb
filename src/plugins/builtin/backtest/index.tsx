import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { backtestHeadless } from "./headless";
import { BACKTEST_PRESETS, LOOKBACK_OPTIONS } from "./presets";
import { BACKTEST_FRESHNESS } from "./report";

export const backtestModule: PluginModule = {
  panes: [{
    id: "backtest", name: "Backtest", icon: "B", get component(): typeof import("./pane").BacktestPane { const { BacktestPane } = require("./pane"); return BacktestPane; },
    defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 120, height: 34 },
    tableExport: true,
    // A capture is dated as `fn BT` dates the run, by its last session, never by the ticker's live quote.
    reportFreshness: { status: BACKTEST_FRESHNESS.status, basis: BACKTEST_FRESHNESS.basis },
    settings: { title: "Backtest Rules", fields: [
      { key: "preset", label: "Strategy", type: "select",
        options: [...BACKTEST_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })), { value: "custom", label: "Custom rules" }] },
      { key: "entry", label: "Custom entry rule", type: "text", placeholder: "close > sma(200)" },
      { key: "exit", label: "Custom exit rule", type: "text", placeholder: "close < sma(200)" },
      { key: "lookback", label: "Lookback", type: "select", options: LOOKBACK_OPTIONS },
      { key: "cost", label: "Cost per side (bp)", type: "text", placeholder: "5" },
    ] },
  }],
  paneTemplates: (["BT", "BTST"] as const).map((shortcut) => ({
    ...createTickerSurfacePaneTemplate({
      id: shortcut === "BT" ? "backtest-pane" : "backtest-btst-pane", paneId: "backtest",
      label: shortcut === "BT" ? "Backtest" : "Backtest (BTST)",
      description: "Test a long-only indicator rule on daily history against buy-and-hold.",
      keywords: ["bt", "btst", "backtest", "strategy", "rules", "sma", "rsi", "macd"], shortcut,
    }),
    headless: backtestHeadless,
  })),
};
