import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { shortVolumeCache } from "./client";
import { shortVolumeHeadless } from "./headless";
import { ShortVolumePane } from "./pane";

export const shortVolumeSettings = [
  { key: "shortVolumeScope", label: "Reporting scope", type: "select" as const,
    options: [{ value: "nms", label: "NMS off-exchange" }, { value: "otc", label: "OTC Reporting Facility" }] },
  { key: "finraSymbol", label: "FINRA symbol override", type: "text" as const, placeholder: "Exact source identity, e.g. ABRpD" },
];
export const shortVolumeModule: PluginModule = {
  panes: [{ id: "short-volume", name: "Daily Short Volume", icon: "S", component: ShortVolumePane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 92, height: 28 },
    tableExport: true, headless: shortVolumeHeadless, settings: { title: "Daily Short Volume", fields: shortVolumeSettings } }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({ id: "short-volume-pane", paneId: "short-volume", label: "Daily Short Volume",
    description: "FINRA daily off-exchange short-volume ratios, historical percentile and reported share quantities.",
    shortcut: "SIV", keywords: ["daily", "short", "volume", "finra", "siv"], publicShare: true,
  }), headless: shortVolumeHeadless }],
  setup(ctx) { shortVolumeCache.attach(ctx.persistence); },
  dispose() { shortVolumeCache.reset(); },
};
