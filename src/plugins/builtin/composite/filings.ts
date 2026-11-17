import { composeBuiltinPlugin } from "../plugin-module";
import { rendererOnly } from "./shared";
import { filingsPluginMeta } from "../builtin-plugin-meta";
import { catalystsModule } from "../catalysts";
import { filingEventsModule } from "../filing-events";
import { mnaModule } from "../mna";
import { riskFactorsModule } from "../risk-factors";
import { secModule } from "../sec";

export const filingsPlugin = composeBuiltinPlugin({
  ...filingsPluginMeta,
  modules: [secModule, riskFactorsModule, filingEventsModule, catalystsModule, mnaModule].map(rendererOnly),
});
