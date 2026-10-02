import {
  attachFredSeriesPersistence,
  resetFredSeriesPersistence,
} from "../../sources/gloomberb-cloud/fred-series";
import type { PluginModule } from "./plugin-module";

/** Persistence for the FRED series cache the Macro panes share. Browser-safe. */
export const macroSharedResourcesModule = {
  setup(ctx) {
    attachFredSeriesPersistence(ctx.persistence);
  },
  dispose() {
    resetFredSeriesPersistence();
  },
} satisfies PluginModule;
