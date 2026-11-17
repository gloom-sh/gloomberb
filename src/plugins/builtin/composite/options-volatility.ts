import { composeBuiltinPlugin } from "../plugin-module";
import { rendererOnly } from "./shared";
import { optionsVolatilityPluginMeta } from "../builtin-plugin-meta";
import { ivHistoryModule } from "../iv-history";
import { optionsModule } from "../options";
import { optionsCalculatorModule } from "../options-calculator";
import { optionsPositioningModule } from "../options-positioning";
import { optionsScenarioModule } from "../options-scenario";
import { realizedVolModule } from "../realized-vol";
import { volSurfaceModule } from "../vol-surface";

export const optionsVolatilityPlugin = composeBuiltinPlugin({
  ...optionsVolatilityPluginMeta,
  modules: [
    optionsModule,
    optionsPositioningModule,
    optionsCalculatorModule,
    optionsScenarioModule,
    volSurfaceModule,
    realizedVolModule,
    ivHistoryModule,
  ].map(rendererOnly),
});
