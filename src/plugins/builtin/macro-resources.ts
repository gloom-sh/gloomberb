import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../data/fred-series";
import {
  attachValuationPersistence,
  resetValuationPersistence,
} from "./market-valuation/cache";
import type { PluginModule } from "./plugin-module";

/** Persistence for the FRED series and valuation caches the Macro panes share. Browser-safe. */
export const macroSharedResourcesModule = {
  setup(ctx) {
    attachFredSeriesPersistence(ctx.persistence);
    attachValuationPersistence(ctx.persistence);
  },
  dispose() {
    resetFredSeriesPersistence();
    resetValuationPersistence();
  },
} satisfies PluginModule;
