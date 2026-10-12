import type { PluginModule } from "../plugin-module";
import {
  attachRiskFactorsPersistence,
  resetRiskFactorsPersistence,
} from "./data";

export const riskFactorsModule: PluginModule = {
  setup(ctx) {
    attachRiskFactorsPersistence(ctx.persistence);
  },

  dispose() {
    resetRiskFactorsPersistence();
  },

};
