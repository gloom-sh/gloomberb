import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { timeSalesHeadless } from "./headless";
import { TimeSalesPane } from "./pane";
export const timeSalesModule: PluginModule = {
  panes: [{ id: "time-sales", name: "Time and Sales", icon: "T", component: TimeSalesPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 104, height: 28 },
    tableExport: true, headless: timeSalesHeadless, settings: { title: "Time and Sales", fields: [{ key: "tab", label: "View", type: "select", options: [{ value: "trades", label: "Trades" }, { value: "quotes", label: "NBBO" }] }] } }],
  paneTemplates: [
    { ...createTickerSurfacePaneTemplate({ id: "time-sales-tas", paneId: "time-sales", label: "Time and Sales",
      description: "Trade prints, observed VWAP and large prints.", keywords: ["tape", "trades", "sales", "prints", "tas"],
      shortcut: "TAS", viewKey: "TAS", settings: () => ({ tab: "trades" }) }), headless: timeSalesHeadless },
    { ...createTickerSurfacePaneTemplate({ id: "time-sales-qr", paneId: "time-sales", label: "Quote Recap",
      description: "NBBO history: bid and ask with sizes, venues and spread.", keywords: ["nbbo", "quotes", "bid", "ask", "recap", "qr"],
      shortcut: "QR", viewKey: "QR", settings: () => ({ tab: "quotes" }) }), headless: timeSalesHeadless },
  ],
};
