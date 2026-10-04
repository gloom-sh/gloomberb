import type { PluginModule } from "../plugin-module";
import { powerBoardCache, powerDetailCache, powerHistoryCache } from "./client";
import { powerHeadless } from "./headless";
import { PowerPane } from "./pane";

export const powerModule: PluginModule = {
  panes: [{ id: "power", name: "Power & Grid", icon: "P", component: PowerPane, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 132, height: 34 }, tableExport: true, headless: powerHeadless }],
  paneTemplates: [{ id: "power-pane", paneId: "power", label: "Power & Grid",
    description: "Pro: interconnection queues, historical MW and outcomes, datacenter loads, utility exposure and generation capacity, with primary evidence.",
    keywords: ["power", "electricity", "interconnection", "grid", "datacenter", "utility", "renewables", "storage", "capacity"],
    shortcut: { prefix: "POWER", argKind: "text", argPlaceholder: "ticker", argOptional: true }, headless: powerHeadless,
    createInstance: (_context, options) => ({ placement: "floating", params: { symbol: options?.symbol ?? options?.arg?.trim().toUpperCase() ?? "" } }) }],
  setup(ctx) { for (const cache of [powerBoardCache, powerHistoryCache, powerDetailCache]) cache.attach(ctx.persistence); },
  dispose() { for (const cache of [powerBoardCache, powerHistoryCache, powerDetailCache]) cache.reset(); },
};
