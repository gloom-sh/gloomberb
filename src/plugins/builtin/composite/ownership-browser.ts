import { composeBuiltinPlugin } from "../plugin-module";
import { ownershipPluginMeta } from "../builtin-plugin-meta";
import { buybacksModule } from "../buybacks";
import { dilutionModule } from "../dilution";
import { holdersModule } from "../holders";
import { insiderModule } from "../insider";
import { shortInterestModule } from "../short-interest";
import { shortVolumeModule } from "../short-volume";
import { thirteenFModule } from "../thirteenf";

/** The web app's Ownership & Insiders: the terminal's without the Congress tab. */
export const browserOwnershipPlugin = composeBuiltinPlugin({
  ...ownershipPluginMeta,
  description: "Holders, 13F funds, insider trades, Hong Kong buybacks, and short interest and volume.",
  // The public 13F fallback goes through the same host proxy as other plugins.
  hosts: ["forms13f.com"],
  modules: [
    holdersModule,
    thirteenFModule,
    // Form 4s come through Gloom Cloud, behind a sign-in wall.
    insiderModule,
    buybacksModule,
    dilutionModule,
    // Daily volume shares open this pane.
    shortInterestModule,
    shortVolumeModule,
  ],
});
