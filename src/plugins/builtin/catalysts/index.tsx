import type { PluginModule } from "../plugin-module";
import { catalystCache, catalystDetailCache } from "./client";
export const catalystsModule: PluginModule = {
  setup(ctx) {
    for (const cache of [catalystCache, catalystDetailCache]) cache.attach(ctx.persistence);
  },
  dispose() { catalystCache.reset(); catalystDetailCache.reset(); },
};
