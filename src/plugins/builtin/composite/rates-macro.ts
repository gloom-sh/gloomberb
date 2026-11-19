import { composeBuiltinPlugin } from "../plugin-module";
import { ratesMacroPluginMeta } from "../builtin-plugin-meta";
import { centralBankRatesModule } from "../central-bank-rates";
import { cpiModule } from "../cpi";
import { economicCalendarModule } from "../econ";
import { econStatisticsModule } from "../econ-statistics";
import { macroSharedResourcesModule } from "../macro-resources";
import { marketValuationModule } from "../market-valuation";
import { moneyMarketsModule } from "../money-markets";
import { ratePathModule } from "../rate-path";
import { volatilityModule } from "../volatility";
import { yieldCurveModule } from "../yield-curve";

export const ratesMacroPlugin = composeBuiltinPlugin({
  ...ratesMacroPluginMeta,
  modules: [
    // The FRED cache the other panes and the chart composer read too. Every
    // plugin is set up whether or not it is switched on, so it stays attached.
    macroSharedResourcesModule,
    economicCalendarModule,
    econStatisticsModule,
    cpiModule,
    yieldCurveModule,
    ratePathModule,
    moneyMarketsModule,
    centralBankRatesModule,
    volatilityModule,
    marketValuationModule,
  ],
});
