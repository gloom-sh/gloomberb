import type { PluginModule } from "../plugin-module";
import { mnaDealCache, mnaDealsCache } from "./client";
import { DISTRESS_CACHES } from "./distress/client";

export const mnaModule: PluginModule = {
  setup(ctx) {
    mnaDealsCache.attach(ctx.persistence);
    mnaDealCache.attach(ctx.persistence);
    for (const cache of DISTRESS_CACHES) cache.attach(ctx.persistence);
  },

  dispose() {
    mnaDealsCache.reset();
    mnaDealCache.reset();
    for (const cache of DISTRESS_CACHES) cache.reset();
  },
};
