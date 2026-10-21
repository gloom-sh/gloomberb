import type { PluginModule } from "../plugin-module";
import { brokerOrdersHeadless } from "./headless";
import { BrokerOrdersPane, BrokerTradeTab } from "./pane";
import { brokerCanTrade, createTradeCommand, openTradeTicket } from "./command";
import { brokerOrderFeed } from "./order-feed";
import { tickerSecType } from "./pane-model";

/** Every enabled trading profile's orders, held for as long as the app runs: its fills toast with no ticket open. */
let releaseHeldOrders: (() => void) | undefined;

/** A ticker without a saved asset category trades as its research instrument kind says. */
const INSTRUMENT_CATEGORY: Record<string, string> = { option: "OPT", future: "FUT", bond: "BOND", crypto: "CRYPTO", currency: "CASH" };

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
    brokerOrderFeed.setNotifier((notification) => { ctx.notify(notification); });
    let held = new Map<string, { key: string; release(): void }>();
    // A broker registered by a later plugin, or a profile added or edited, is held from then on.
    const holdProfiles = () => {
      const next = new Map<string, { key: string; release(): void }>();
      for (const instance of ctx.getConfig().brokerInstances) {
        const broker = instance.enabled === false ? null : ctx.getBrokerAdapter?.(instance.brokerType);
        if (!broker?.listOpenOrders || !broker.placeOrder) continue;
        const key = JSON.stringify([broker.id, instance.config]);
        const current = held.get(instance.id);
        if (current?.key === key) { next.set(instance.id, current); held.delete(instance.id); continue; }
        next.set(instance.id, { key, release: brokerOrderFeed.hold(broker, instance) });
      }
      for (const stale of held.values()) stale.release();
      held = next;
    };
    const unsubscribe = [ctx.on("config:changed", holdProfiles), ctx.on("plugin:registered", holdProfiles)];
    holdProfiles();
    releaseHeldOrders = () => {
      for (const stop of unsubscribe) stop();
      for (const entry of held.values()) entry.release();
      held.clear();
      brokerOrderFeed.setNotifier(undefined);
      brokerOrderFeed.clear();
    };
    const supported = (symbol: string, secType = "STK") => brokerCanTrade(ctx.getConfig().brokerInstances, (type) => ctx.getBrokerAdapter?.(type), symbol, secType);
    ctx.registerTickerResearchTab({
      id: "broker-trade", name: "Trade", order: 20, component: BrokerTradeTab,
      instruments: ["equity", "fund", "option", "future", "bond", "crypto", "currency", "other"],
      isVisible: ({ ticker, instrumentKind }) => supported(ticker?.metadata.ticker ?? "", tickerSecType(ticker?.metadata.assetCategory, INSTRUMENT_CATEGORY[instrumentKind])),
    });
    for (const side of ["BUY", "SELL"] as const) {
      ctx.registerCommand(createTradeCommand(ctx, side, supported));
      ctx.registerTickerAction({
        id: `broker-${side.toLowerCase()}`, label: side === "BUY" ? "Buy" : "Sell",
        keywords: [side.toLowerCase(), "trade", "order", "broker"],
        filter: (ticker) => supported(ticker.metadata.ticker, tickerSecType(ticker.metadata.assetCategory)),
        execute: (ticker) => {
          openTradeTicket(ctx, ticker.metadata.ticker, { action: side });
        },
      });
    }
  },
  dispose() {
    releaseHeldOrders?.();
    releaseHeldOrders = undefined;
  },
};
