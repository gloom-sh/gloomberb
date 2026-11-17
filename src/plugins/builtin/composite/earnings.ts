import { composeBuiltinPlugin } from "../plugin-module";
import { tickerResearchModule } from "./shared";
import { earningsPluginMeta } from "../builtin-plugin-meta";
import { earningsModule } from "../earnings";
import { earningsCallsModule } from "../earnings-calls";
import { earningsRippleModule } from "../earnings-ripple";

export const earningsPlugin = composeBuiltinPlugin({
  ...earningsPluginMeta,
  description: "Earnings calendar with surprises and implied moves, call transcripts, and the earnings ripple through customers and suppliers.",
  modules: [earningsModule, earningsCallsModule, tickerResearchModule(earningsRippleModule)],
});
