import { composeBuiltinPlugin } from "../plugin-module";
import { runtimeOnly } from "./shared";
import { futuresCommoditiesPluginMeta } from "../builtin-plugin-meta";
import { commoditiesEnergyModule } from "../commodities-energy";
import { commodityBalancesModule } from "../commodity-balances";
import { cotModule } from "../cot";
import { doeModule } from "../doe";
import { futuresModule } from "../futures";
import { futuresCurveModule } from "../futures-curve";
import { jodiModule } from "../jodi";

export const futuresCommoditiesPlugin = composeBuiltinPlugin({
  ...futuresCommoditiesPluginMeta,
  modules: [
    commoditiesEnergyModule,
    runtimeOnly(futuresModule),
    runtimeOnly(futuresCurveModule),
    runtimeOnly(cotModule),
    runtimeOnly(doeModule),
    { module: runtimeOnly(commodityBalancesModule), stateId: "commodity-balances" },
    { module: runtimeOnly(jodiModule), stateId: "jodi" },
  ],
});
