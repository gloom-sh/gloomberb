import { composeBuiltinPlugin } from "../plugin-module";
import { portfolioAnalyticsModule } from "../analytics";
import { portfolioPluginMeta } from "../builtin-plugin-meta";
import { positionSizerModule } from "../kelly-sizer";
import { portfolioListModule } from "../portfolio-list";

export const portfolioPlugin = composeBuiltinPlugin({
  ...portfolioPluginMeta,
  modules: [portfolioListModule, portfolioAnalyticsModule, positionSizerModule],
});
