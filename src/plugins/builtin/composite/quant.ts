import { composeBuiltinPlugin } from "../plugin-module";
import { rendererOnly } from "./shared";
import { backtestModule } from "../backtest";
import { quantPluginMeta } from "../builtin-plugin-meta";
import { correlationModule } from "../correlation";
import { macroDayModule } from "../macro-day";
import { seasonalityModule } from "../seasonality";

export const quantPlugin = composeBuiltinPlugin({
  ...quantPluginMeta,
  modules: [
    { module: correlationModule, stateId: "market-overview" },
    ...[backtestModule, seasonalityModule, macroDayModule].map(rendererOnly),
  ],
});
