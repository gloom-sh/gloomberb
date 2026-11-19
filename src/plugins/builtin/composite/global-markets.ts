import { composeBuiltinPlugin } from "../plugin-module";
import { globalMarketsPluginMeta } from "../builtin-plugin-meta";
import { fxMatrixModule } from "../fx-matrix";
import { relativeRotationModule } from "../relative-rotation";
import { sectorsModule } from "../sectors";
import { worldIndicesModule } from "../world-indices";
import { worldVenueMapModule } from "../world-venue-map";

export const globalMarketsPlugin = composeBuiltinPlugin({
  ...globalMarketsPluginMeta,
  modules: [worldIndicesModule, worldVenueMapModule, sectorsModule, fxMatrixModule, relativeRotationModule],
});
