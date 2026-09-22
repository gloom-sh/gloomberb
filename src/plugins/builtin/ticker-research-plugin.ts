import { shortVolumeModule } from "./short-volume";
import { chartComposerModule } from "./chart-composer";
import { congressResearchModule } from "./congress-trades";
import { dividendYieldModule } from "./dividend-yield";
import { executivesModule } from "./executives";
import { filingEventsModule } from "./filing-events";
import { holdersModule } from "./holders";
import { insiderModule } from "./insider";
import { jobsModule } from "./jobs";
import { optionsModule } from "./options";
import { optionsCalculatorModule } from "./options-calculator";
import { volSurfaceModule } from "./vol-surface";
import { realizedVolModule } from "./realized-vol";
import { composeBuiltinPlugin } from "./plugin-module";
import { researchModule } from "./research";
import { riskFactorsModule } from "./risk-factors";
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
    congressResearchModule,
    optionsModule,
    optionsCalculatorModule,
    volSurfaceModule,
    realizedVolModule,
    researchModule,
    shortVolumeModule,
    dividendYieldModule,
    holdersModule,
    shortInterestModule,
    thirteenFModule,
    secModule,
    insiderModule,
    jobsModule,
    executivesModule,
    riskFactorsModule,
    filingEventsModule,
  ],
});
