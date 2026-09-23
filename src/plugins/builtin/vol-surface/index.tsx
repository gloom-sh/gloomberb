import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { VolSurfacePane } from "./pane";
import { volSurfaceHeadless } from "./headless";

export const volSurfaceModule: PluginModule = {
  panes: [{
    id: "vol-surface", name: "Volatility Surface", icon: "V", component: VolSurfacePane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 126, height: 36 },
    tableExport: true, headless: volSurfaceHeadless,
    settings: {
      title: "Volatility Surface Settings",
      fields: [
        { key: "surfaceAxis", label: "3D surface axis", type: "select", options: [
          { value: "delta", label: "Delta (10P to 10C)" }, { value: "moneyness", label: "Forward moneyness" }] },
        { key: "axis", label: "Table / smile axis", type: "select", options: [
          { value: "spot", label: "Spot %" }, { value: "forward", label: "Forward %" },
          { value: "delta", label: "Delta" }, { value: "strike", label: "Strike" },
        ] },
        { key: "tenors", label: "Table tenors", type: "select", options: [
          { value: "listed", label: "Listed expiries" }, { value: "fixed", label: "Fixed tenors (interpolated)" },
        ] },
        { key: "ivSource", label: "Implied volatility", type: "select", options: [
          { value: "recomputed", label: "Recomputed from quote" }, { value: "provider", label: "Provider comparison" },
        ] },
        { key: "priceSide", label: "Quote price", type: "select", options: [
          { value: "mid", label: "Mid" }, { value: "bid", label: "Bid" }, { value: "ask", label: "Ask" },
        ] },
        { key: "maxRelativeSpread", label: "Maximum spread / mid", type: "select", options: [
          { value: "0.25", label: "25%" }, { value: "0.5", label: "50%" }, { value: "1", label: "100%" },
        ] },
        { key: "maxStaleSessions", label: "Stale trade threshold", type: "select", options: [
          { value: "2", label: "2 sessions" }, { value: "5", label: "5 sessions" }, { value: "10", label: "10 sessions" },
        ] },
        { key: "overlaySmiles", label: "Overlay nearby expiries", type: "toggle" },
      ],
    },
  }],
  paneTemplates: [createTickerSurfacePaneTemplate({
    id: "vol-surface-pane", paneId: "vol-surface", label: "Volatility Surface",
    description: "Implied volatility surface, smiles, term structure, skew and forwards.",
    keywords: ["ovdv", "volatility", "surface", "smile", "skew", "options"],
    shortcut: "OVDV", publicShare: true,
    settings: (_symbol, _context, options) => options?.values?.expiration
      ? { expiration: Number(options.values.expiration) } : {},
  })],
};
