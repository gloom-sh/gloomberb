import { composeBuiltinPlugin } from "../plugin-module";
import { applicationPluginMeta } from "../builtin-plugin-meta";
import { changelogModule } from "../changelog";
import { connectionsModule } from "../connections";
import { docsModule } from "../docs";
import { helpModule } from "../help";
import { layoutManagerModule } from "../layout-manager";
import { pluginMarketplaceModule } from "../plugin-marketplace";
import { roadmapModule } from "../roadmap";

export const applicationPlugin = composeBuiltinPlugin({
  ...applicationPluginMeta,
  modules: [layoutManagerModule, pluginMarketplaceModule, helpModule, changelogModule, connectionsModule, docsModule, roadmapModule],
});
