import { composeBuiltinPlugin } from "../plugin-module";
import { cryptoPluginMeta } from "../builtin-plugin-meta";
import { cryptoBoardModule } from "../crypto-board";
import { cryptoEtfFlowsModule } from "../crypto-etf-flows";
import { perpsModule } from "../perps";

export const cryptoPlugin = composeBuiltinPlugin({
  ...cryptoPluginMeta,
  modules: [cryptoBoardModule, cryptoEtfFlowsModule, perpsModule],
});
