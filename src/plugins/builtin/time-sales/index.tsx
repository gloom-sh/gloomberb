import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { timeSalesHeadless } from "./headless";
import { TimeSalesPane } from "./pane";
export const timeSalesModule: PluginModule = {
  panes: [{ id: "time-sales", name: "Time and Sales", icon: "T", component: TimeSalesPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 104, height: 28 },
    tableExport: true, headless: timeSalesHeadless, settings: { title: "Time and Sales", fields: [{ key: "tab", label: "View", type: "select", options: [{ value: "trades", label: "Trades" }, { value: "quotes", label: "NBBO" }] }] } }],
  paneTemplates: ["TAS", "QR"].map((shortcut) => ({
    ...createTickerSurfacePaneTemplate({ id: `time-sales-${shortcut.toLowerCase()}`, paneId: "time-sales", label: "Time and Sales",
      description: "Trade prints, observed VWAP, large prints and NBBO history.", keywords: ["tape", "trades", "sales", "nbbo", "quotes", shortcut.toLowerCase()], shortcut, viewKey: shortcut, settings: () => ({ tab: shortcut === "QR" ? "quotes" : "trades" }) }),
    headless: timeSalesHeadless,
  })),
};
