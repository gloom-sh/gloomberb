import { composeBuiltinPlugin } from "../plugin-module";
import { screenersPluginMeta } from "../builtin-plugin-meta";
import { equityScreenerModule } from "../equity-screener";
import { marketMoversModule } from "../market-movers";
import { scannerModule } from "../scanner";

export const screenersPlugin = composeBuiltinPlugin({
  ...screenersPluginMeta,
  description: "Equity screener, top movers, session highs and lows, and unusual options flow.",
  modules: [equityScreenerModule, marketMoversModule, scannerModule],
});
