import type { BrokerContractRef } from "../../../types/instrument";
import type { PluginModule } from "../plugin-module";
import { brokerOrdersHeadless } from "./headless";
import { BrokerOrdersPane, BrokerTradeTab, setTradeIntent } from "./pane";

/** Trading lives with broker profiles, with one research tab and one orders view. */
export const brokerTradingModule: PluginModule = {
  panes: [{
    id: "broker-orders", name: "Orders", icon: "O", component: BrokerOrdersPane,
    defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 100, height: 30 }, headless: brokerOrdersHeadless,
    portableShare: { private: { title: true, params: true, settings: true, state: true } },
  }],
  paneTemplates: [{
    id: "broker-orders-pane", paneId: "broker-orders", label: "Orders",
    description: "Open orders and recent activity for a broker account",
    keywords: ["orders", "trades", "executions", "cancel", "modify"],
    shortcut: { prefix: "ORD" }, headless: brokerOrdersHeadless,
    createInstance: () => ({ placement: "floating" }),
  }],
  setup(ctx) {
    const supported = (symbol: string, secType = "STK") => ctx.getConfig().brokerInstances.some((profile) => {
      if (profile.enabled === false) return false;
      const adapter = ctx.getBrokerAdapter?.(profile.brokerType);
      const contract: BrokerContractRef = { brokerId: adapter?.id ?? "", brokerInstanceId: profile.id, symbol, secType };
      return !!adapter?.placeOrder && !!adapter.previewOrder && !!adapter.getTradingCapabilities?.(profile, contract).orderTypes.length;
    });
    ctx.registerTickerResearchTab({
      id: "broker-trade", name: "Trade", order: 20, component: BrokerTradeTab,
      instruments: ["equity", "fund", "option", "future", "bond", "crypto", "currency", "other"],
      isVisible: ({ ticker, instrumentKind }) => supported(ticker?.metadata.ticker ?? "", ticker?.metadata.assetCategory ?? ({ option: "OPT", future: "FUT", bond: "BOND", crypto: "CRYPTO", currency: "CASH" } as Record<string, string>)[instrumentKind] ?? "STK"),
    });
    for (const side of ["BUY", "SELL"] as const) ctx.registerTickerAction({
      id: `broker-${side.toLowerCase()}`, label: side === "BUY" ? "Buy" : "Sell",
      keywords: [side.toLowerCase(), "trade", "order", "broker"],
      filter: (ticker) => supported(ticker.metadata.ticker, ticker.metadata.assetCategory),
      execute: (ticker) => {
        setTradeIntent(ticker.metadata.ticker, side);
        ctx.pinTicker(ticker.metadata.ticker, { tabId: "broker-trade" });
      },
    });
  },
};
