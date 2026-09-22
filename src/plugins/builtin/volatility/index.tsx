import type { PluginModule } from "../plugin-module";
import { volatilityHeadless } from "./headless";
import { VolatilityPane } from "./pane";

export { volatilityHeadless } from "./headless";
export { VolatilityPane } from "./pane";

export const volatilityModule: PluginModule = {
  panes: [{
    id: "volatility-term-structure", name: "Volatility", icon: "V", component: VolatilityPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 110, height: 34 },
    tableExport: true, headless: volatilityHeadless,
  }],
  paneTemplates: [{
    id: "volatility-term-structure-pane", paneId: "volatility-term-structure",
    label: "VIX Curve", description: "Dated VIX tenor closes, FRED history and the cross-asset volatility board.",
    keywords: ["vix", "volatility", "curve", "contango", "backwardation", "vvix", "skew", "move"],
    shortcut: { prefix: "VIX" }, headless: volatilityHeadless,
    createInstance: () => ({ instanceId: "volatility:curve", title: "VIX", placement: "floating", settings: { initialTab: "curve" } }),
  }, {
    id: "volatility-board-pane", paneId: "volatility-term-structure",
    label: "Cross-asset Volatility", description: "Volatility index closes, daily changes and one-year percentiles.",
    keywords: ["volatility", "cross asset", "vols", "vxn", "ovx", "gvz"],
    shortcut: { prefix: "VOLS" }, headless: volatilityHeadless,
    createInstance: () => ({ instanceId: "volatility:board", title: "VOLS", placement: "floating", settings: { initialTab: "board" } }),
  }],
};
