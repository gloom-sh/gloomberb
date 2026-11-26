import { composeBuiltinPlugin } from "../plugin-module";
import { rendererOnly } from "./shared";
import { ownershipPluginMeta } from "../builtin-plugin-meta";
import { congressResearchModule } from "../congress-trades";
import { buybacksModule } from "../buybacks";
import { dilutionModule } from "../dilution";
import { holdersModule } from "../holders";
import { insiderModule } from "../insider";
import { shortInterestModule } from "../short-interest";
import { shortVolumeModule } from "../short-volume";
import { thirteenFModule } from "../thirteenf";

export const ownershipPlugin = composeBuiltinPlugin({
  ...ownershipPluginMeta,
  description: "Holders, 13F funds, insider trades, Hong Kong buybacks, short interest and volume, and congressional trades.",
  modules: [
    holdersModule,
    thirteenFModule,
    insiderModule,
    buybacksModule,
    dilutionModule,
    shortInterestModule,
    shortVolumeModule,
    // The Congress research tab; the CONG pane is Gloom Cloud's.
    congressResearchModule,
  ].map(rendererOnly),
});
