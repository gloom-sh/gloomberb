import type { PluginModule } from "../plugin-module";
import { brokerOrdersHeadless } from "./headless";
import { BrokerOrdersPane, BrokerTradeTab } from "./pane";
import { brokerCanTrade, createTradeCommand, openTradeTicket } from "./command";

/** Trading lives with broker profiles, with one research tab and one orders view. */
export const brokerTradingModule: PluginModule = {
  panes: [{
    id: "broker-orders", name: "Orders", personalData: "account", icon: "O", component: BrokerOrdersPane,
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
    const supported = (symbol: string, secType = "STK") => brokerCanTrade(ctx.getConfig().brokerInstances, (type) => ctx.getBrokerAdapter?.(type), symbol, secType);
    ctx.registerTickerResearchTab({
      id: "broker-trade", name: "Trade", order: 20, component: BrokerTradeTab,
      instruments: ["equity", "fund", "option", "future", "bond", "crypto", "currency", "other"],
      isVisible: ({ ticker, instrumentKind }) => supported(ticker?.metadata.ticker ?? "", ticker?.metadata.assetCategory ?? ({ option: "OPT", future: "FUT", bond: "BOND", crypto: "CRYPTO", currency: "CASH" } as Record<string, string>)[instrumentKind] ?? "STK"),
    });
    for (const side of ["BUY", "SELL"] as const) {
      ctx.registerCommand(createTradeCommand(ctx, side, supported));
      ctx.registerTickerAction({
        id: `broker-${side.toLowerCase()}`, label: side === "BUY" ? "Buy" : "Sell",
        keywords: [side.toLowerCase(), "trade", "order", "broker"],
        filter: (ticker) => supported(ticker.metadata.ticker, ticker.metadata.assetCategory),
        execute: (ticker) => {
          openTradeTicket(ctx, ticker.metadata.ticker, { action: side });
        },
      });
    }
  },
};
