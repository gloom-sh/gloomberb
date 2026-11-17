import { composeBuiltinPlugin } from "../plugin-module";
import { tickerResearchModule } from "./shared";
import { bondCalculatorModule } from "../bond-calculator";
import { creditPluginMeta } from "../builtin-plugin-meta";
import { cdsModule } from "../cds";
import { creditBoardsModule } from "../credit-boards";
import { creditConditionsModule } from "../credit-conditions";
import { creditDocumentsModule } from "../credit-documents";
import { debtMaturitiesModule } from "../debt-maturities";
import { fixedIncomeModule } from "../fixed-income";
import { FIXED_INCOME_HOSTS } from "../fixed-income/model";
import { primaryDealersModule } from "../primary-dealers";
import { traceBondsModule } from "../trace-bonds";
import { treasuryAuctionsModule } from "../treasury-auctions";
import { treasuryDailyModule } from "../treasury-daily";

export const creditPlugin = composeBuiltinPlugin({
  ...creditPluginMeta,
  modules: [
    fixedIncomeModule,
    cdsModule,
    creditBoardsModule,
    creditConditionsModule,
    treasuryAuctionsModule,
    bondCalculatorModule,
    traceBondsModule,
    treasuryDailyModule,
    primaryDealersModule,
    tickerResearchModule(creditDocumentsModule),
    tickerResearchModule(debtMaturitiesModule),
  ],
});
creditPlugin.hosts = [...FIXED_INCOME_HOSTS];
