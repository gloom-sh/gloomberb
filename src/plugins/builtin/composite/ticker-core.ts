import { composeBuiltinPlugin } from "../plugin-module";
import { rendererOnly } from "./shared";
import { tickerCorePluginMeta } from "../builtin-plugin-meta";
import { chartComposerModule } from "../chart-composer";
import { userSeriesModule } from "../chart-composer/user-series";
import { companyKpisModule } from "../company-kpis";
import { dividendYieldModule } from "../dividend-yield";
import { estimateRevisionsModule } from "../estimate-revisions";
import { executivesModule } from "../executives";
import { peBandModule } from "../pe-band";
import { researchModule } from "../research";
import { revenueBreakdownModule } from "../revenue-breakdown";
import { reverseDcfModule } from "../reverse-dcf";
import { tickerDetailModule } from "../ticker-detail";
import { timeSalesModule } from "../time-sales";

export const tickerCorePlugin = composeBuiltinPlugin({
  ...tickerCorePluginMeta,
  modules: [
    ...[
      tickerDetailModule,
      chartComposerModule,
      researchModule,
      estimateRevisionsModule,
      companyKpisModule,
      revenueBreakdownModule,
      dividendYieldModule,
      reverseDcfModule,
      peBandModule,
      executivesModule,
      timeSalesModule,
    ].map(rendererOnly),
    // Reads the profile's series folder, so it runs where the disk is: the desktop backend too.
    userSeriesModule,
  ],
});
