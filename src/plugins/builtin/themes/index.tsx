import type { PluginModule } from "../plugin-module";
import { membersCache, themesCache } from "./client";
import { themesHeadless } from "./headless";
import { ThemesPane } from "./pane";

export const themesModule: PluginModule = {
  panes: [{ id: "themes", name: "Thematic Baskets", icon: "T", component: ThemesPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 120, height: 24 },
    tableExport: true, headless: themesHeadless }],
  paneTemplates: [{ id: "themes-pane", paneId: "themes", label: "Thematic Baskets",
    description: "Curated themes with equal-weight returns, breadth and member leaders and laggards.",
    keywords: ["themes", "thematic", "baskets", "AI compute", "datacenters", "electrification", "power grid", "nuclear", "uranium", "defense", "aerospace", "cybersecurity", "robotics", "automation", "critical minerals", "crypto", "bitcoin", "solar", "clean energy", "gold", "silver", "homebuilders", "memory", "chip equipment", "cloud software"],
    shortcut: { prefix: "THEM", argKind: "text", argPlaceholder: "theme", argOptional: true },
    headless: themesHeadless,
    createInstance: (_context, options) => ({ placement: "floating", params: { theme: options?.arg?.trim() ?? "" } }),
  }],
  setup(ctx) { themesCache.attach(ctx.persistence); membersCache.attach(ctx.persistence); },
  dispose() { themesCache.reset(); membersCache.reset(); },
};
