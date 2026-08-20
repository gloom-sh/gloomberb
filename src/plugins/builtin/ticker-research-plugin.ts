import { chartComposerModule } from "./chart-composer";
import { dividendYieldModule } from "./dividend-yield";
import { holdersModule } from "./holders";
import { insiderModule } from "./insider";
import { optionsModule } from "./options";
import { optionsCalculatorModule } from "./options-calculator";
import { composeBuiltinPlugin } from "./plugin-module";
import { researchModule } from "./research";
import { secModule } from "./sec";
import { shortInterestModule } from "./short-interest";
import { thirteenFModule } from "./thirteenf";
import { tickerDetailModule } from "./ticker-detail";

export const tickerResearchPlugin = composeBuiltinPlugin({
  id: "ticker-research",
  name: "Ticker Research",
  version: "1.0.0",
  description: "Company research workspace: overview, charts, financials, filings, ownership, options, analyst research, and events.",
  toggleable: true,
  modules: [
    tickerDetailModule,
    chartComposerModule,
    optionsModule,
    optionsCalculatorModule,
    researchModule,
    dividendYieldModule,
    holdersModule,
    shortInterestModule,
    thirteenFModule,
    secModule,
    insiderModule,
  ],
});
