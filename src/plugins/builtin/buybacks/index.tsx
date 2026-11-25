import type { PluginModule } from "../plugin-module";
import { buybacksCache, buybackSymbol } from "./client";
import { BUYBACK_SERIES } from "./series";

/** Ticker Research's Buybacks view: a Hong Kong listing's repurchases by session, its mandate and its blackout windows. */
export const buybacksModule: PluginModule = {
  series: BUYBACK_SERIES,
  setup(ctx) {
    buybacksCache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "buybacks",
      name: "Buybacks",
      order: 44,
      get component(): typeof import("./pane").BuybacksView { const { BuybacksView } = require("./pane"); return BuybacksView; },
      instruments: ["equity"],
      isVisible: ({ ticker }) => !!ticker && !!buybackSymbol(ticker.metadata.ticker, ticker.metadata.exchange),
    });
  },
  dispose() {
    buybacksCache.reset();
  },
};
