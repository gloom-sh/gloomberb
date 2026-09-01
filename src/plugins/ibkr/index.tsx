import type { GloomPlugin, GloomPluginContext } from "../../types/plugin";
import { ibkrBroker } from "./broker-adapter";
import { buildPersistedIbkrGatewayConfig } from "./config";
import { ibkrGatewayManager, setResolvedIbkrGatewayListener } from "./gateway/service";
import {
  getTradeTicketState,
  getTradingPaneState,
  prefillTradeFromTicker,
  removeBrokerInstanceFromTradingState,
} from "./trading/state";
import { getConfiguredIbkrGatewayInstances } from "./instance-selection";
import { hasIbkrTradingProfiles } from "./trade/utils";
import { TradeTab } from "./trade/tab";
import { TradingPane } from "./trading/pane";

let lastSelectedTickerSymbol: string | null = null;

function ensureIbkrTradingProfile(ctx: GloomPluginContext): boolean {
  if (hasIbkrTradingProfiles(ctx.getConfig())) return true;
  ctx.notify({ body: "Connect a Gateway / TWS IBKR profile first.", type: "info" });
  return false;
}

function openTradeForSymbol(
  ctx: GloomPluginContext,
  symbol: string,
  action?: "BUY" | "SELL",
) {
  const ticker = ctx.getTicker(symbol);
  if (!ticker) return;

  if (action) {
    prefillTradeFromTicker(ticker, action);
  } else {
    const current = getTradeTicketState(ticker.metadata.ticker, ticker);
    prefillTradeFromTicker(ticker, current.draft.action || "BUY");
  }

  ctx.switchPanel("right");
  ctx.switchTab("ibkr-trade");
}

export const ibkrPlugin: GloomPlugin = {
  id: "ibkr",
  name: "Interactive Brokers",
  version: "1.0.0",
  description: "Interactive Brokers market data, account sync, and trading.",
  toggleable: true,
  broker: ibkrBroker,
  paneTemplates: [
    {
      id: "new-ibkr-trading-pane",
      paneId: "ibkr-trading",
      label: "New IBKR Trading Pane",
      description: "Open another floating IBKR trading console",
      keywords: ["new", "ibkr", "trading", "status", "orders", "pane"],
      shortcut: { prefix: "IBKR" },
      canCreate: (context) => getConfiguredIbkrGatewayInstances(context.config).length > 0,
      createInstance: () => ({ placement: "floating" }),
    },
  ],

  setup(ctx) {
    ctx.log.info("IBKR plugin initializing");
    setResolvedIbkrGatewayListener(async (instanceId, resolved) => {
      if (!instanceId) return;
      const instance = ctx.getConfig().brokerInstances.find((entry) => entry.id === instanceId);
      if (!instance || instance.brokerType !== "ibkr") return;
      const nextConfig = buildPersistedIbkrGatewayConfig(instance.config, resolved);
      if (!nextConfig) return;
      await ctx.updateBrokerInstance(instanceId, nextConfig);
    });

    ctx.registerPane({
      id: "ibkr-trading",
      name: "IBKR Console",
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 84, height: 20 },
      component: TradingPane,
    });

    ctx.registerTickerResearchTab({
      id: "ibkr-trade",
      name: "Trade",
      order: 25,
      component: TradeTab,
      isVisible: ({ config }) => getConfiguredIbkrGatewayInstances(config).length > 0,
    });

    ctx.registerTickerAction({
      id: "ibkr-trade",
      label: "Trade",
      keywords: ["trade", "buy", "sell", "ibkr"],
      filter: () => hasIbkrTradingProfiles(ctx.getConfig()),
      execute: async (ticker) => {
        if (!ensureIbkrTradingProfile(ctx)) return;
        openTradeForSymbol(ctx, ticker.metadata.ticker);
      },
    });

    ctx.on("ticker:selected", ({ symbol }) => {
      lastSelectedTickerSymbol = symbol;
    });

    ctx.on("config:changed", ({ config }) => {
      const selectedInstanceId = getTradingPaneState().brokerInstanceId;
      if (selectedInstanceId && !config.brokerInstances.some((instance) => instance.id === selectedInstanceId)) {
        removeBrokerInstanceFromTradingState(selectedInstanceId);
      }
    });

    ctx.registerCommand({
      id: "ibkr-open-trading",
      label: "Open Trading",
      description: "Open the IBKR trade tab for the selected ticker",
      keywords: ["ibkr", "trading", "orders", "trade", "ticker"],
      category: "navigation",
      hidden: () => !hasIbkrTradingProfiles(ctx.getConfig()),
      execute: async () => {
        if (!ensureIbkrTradingProfile(ctx)) return;
        if (!lastSelectedTickerSymbol) return;
        openTradeForSymbol(ctx, lastSelectedTickerSymbol);
      },
    });

    ctx.registerCommand({
      id: "ibkr-buy-selected",
      label: "Buy Selected",
      description: "Prefill the trading pane with a BUY ticket for the selected ticker",
      keywords: ["buy", "trade", "order", "selected", "ibkr"],
      category: "portfolio",
      hidden: () => !hasIbkrTradingProfiles(ctx.getConfig()) || !lastSelectedTickerSymbol,
      execute: async () => {
        if (!ensureIbkrTradingProfile(ctx) || !lastSelectedTickerSymbol) return;
        openTradeForSymbol(ctx, lastSelectedTickerSymbol, "BUY");
      },
    });

    ctx.registerCommand({
      id: "ibkr-sell-selected",
      label: "Sell Selected",
      description: "Prefill the trading pane with a SELL ticket for the selected ticker",
      keywords: ["sell", "trade", "order", "selected", "ibkr"],
      category: "portfolio",
      hidden: () => !hasIbkrTradingProfiles(ctx.getConfig()) || !lastSelectedTickerSymbol,
      execute: async () => {
        if (!ensureIbkrTradingProfile(ctx) || !lastSelectedTickerSymbol) return;
        openTradeForSymbol(ctx, lastSelectedTickerSymbol, "SELL");
      },
    });
  },

  dispose() {
    lastSelectedTickerSymbol = null;
    setResolvedIbkrGatewayListener(null);
    void ibkrGatewayManager.destroyAll().catch(() => {});
  },
};
