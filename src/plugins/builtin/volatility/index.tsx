import type { PluginModule } from "../plugin-module";
import { volatilityHeadless } from "./headless";
import { VOLATILITY_SERIES } from "./series";


export const volatilityModule: PluginModule = {
  series: VOLATILITY_SERIES,
  panes: [{
    id: "volatility-term-structure", name: "Volatility", icon: "V", get component(): typeof import("./pane").VolatilityPane { const { VolatilityPane } = require("./pane"); return VolatilityPane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 110, height: 34 },
    tableExport: true, headless: volatilityHeadless,
  }],
  paneTemplates: [{
    id: "volatility-term-structure-pane", paneId: "volatility-term-structure",
    label: "VIX Curve", description: "Dated VIX tenor closes, the 3M/30D ratio history and the cross-asset volatility board.",
    keywords: ["vix", "volatility", "vol", "curve", "contango", "backwardation", "vvix", "skew", "move"],
    shortcut: { prefix: "VIX" }, headless: volatilityHeadless,
    createInstance: () => ({ instanceId: "volatility:curve", title: "VIX", placement: "floating", settings: { initialTab: "curve" } }),
  }, {
    id: "volatility-board-pane", paneId: "volatility-term-structure",
    label: "Cross-asset Volatility", description: "Volatility index closes, daily changes and one-year percentiles.",
    keywords: ["volatility", "vol", "cross asset", "vols", "vxn", "ovx", "gvz"],
    shortcut: { prefix: "VOLS" }, headless: volatilityHeadless,
    createInstance: () => ({ instanceId: "volatility:board", title: "VOLS", placement: "floating", settings: { initialTab: "board" } }),
  }],
};
