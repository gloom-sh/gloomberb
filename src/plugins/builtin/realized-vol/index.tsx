import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { RealizedVolPane } from "./pane";
import { realizedVolHeadless } from "./headless";
import { ESTIMATOR_OPTIONS, WINDOW_OPTIONS } from "./settings";

export const realizedVolModule: PluginModule = {
  panes: [{
    id: "realized-vol", name: "Realized Volatility", icon: "V", component: RealizedVolPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 112, height: 36 },
    tableExport: true,
    quickSettings: [{ type: "toggle", key: "showIv", icon: "zap", label: "Current ATM IV" }],
    settings: { title: "Realized Volatility Settings", fields: [
      { key: "estimator", label: "Estimator", type: "select", options: ESTIMATOR_OPTIONS },
      { key: "windows", label: "Graph windows", type: "multi-select", options: WINDOW_OPTIONS },
      { key: "lookbackYears", label: "Lookback", type: "select", options: [{ value: "1", label: "1 year" }, { value: "2", label: "2 years" }] },
      { key: "showIv", label: "Current ATM IV", type: "toggle" },
    ] },
  }],
  paneTemplates: [
    { ...createTickerSurfacePaneTemplate({
      id: "realized-vol-graph-pane", paneId: "realized-vol", label: "Realized Volatility Graph",
      description: "Rolling realized volatility, price and a dated current ATM IV reference.",
      keywords: ["hvg", "realized", "historical", "volatility", "gv"], shortcut: "HVG", publicShare: true,
      viewKey: "graph", settings: () => ({ initialView: "graph" }),
    }), headless: realizedVolHeadless("graph") },
    { ...createTickerSurfacePaneTemplate({
      id: "realized-vol-table-pane", paneId: "realized-vol", label: "Realized Volatility Cone",
      description: "Current realized volatility against its historical range and percentile.",
      keywords: ["hvt", "volatility", "cone", "percentile"], shortcut: "HVT", publicShare: true,
      viewKey: "cone", settings: () => ({ initialView: "cone" }),
    }), headless: realizedVolHeadless("cone") },
  ],
};
