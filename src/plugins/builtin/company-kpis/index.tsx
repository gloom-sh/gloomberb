import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { companyKpisCache } from "./client";
import { companyHeadless } from "./headless";
import { CompanyGuidancePane, CompanyKpisPane } from "./pane";

const kpisHeadless = companyHeadless("kpis");
const guidanceHeadless = companyHeadless("guidance");
export const companyKpisModule: PluginModule = {
  setup(ctx) { companyKpisCache.attach(ctx.persistence); },
  dispose() { companyKpisCache.reset(); },
  panes: [
    { id: "company-kpis", name: "Company KPIs", icon: "K", component: CompanyKpisPane, defaultPosition: "right", defaultMode: "floating",
      defaultFloatingSize: { width: 130, height: 30 }, tickerFollower: true, tableExport: true, headless: kpisHeadless },
    { id: "company-guidance", name: "Company Guidance", icon: "G", component: CompanyGuidancePane, defaultPosition: "right", defaultMode: "floating",
      defaultFloatingSize: { width: 130, height: 30 }, tickerFollower: true, tableExport: true, headless: guidanceHeadless },
  ],
  paneTemplates: [
    { ...createTickerSurfacePaneTemplate({ id: "company-kpis-pane", paneId: "company-kpis", label: "Company KPIs", shortcut: "KPIS",
      description: "Pro company operating KPIs, comparable history, revisions and cited evidence. Free preview.",
      keywords: ["kpis", "operating metrics", "arr", "subscribers", "backlog", "occupancy"] }), headless: kpisHeadless },
    { ...createTickerSurfacePaneTemplate({ id: "company-guidance-pane", paneId: "company-guidance", label: "Company Guidance", shortcut: "GUIDE",
      description: "Pro management guidance ranges, raises and cuts, actual versus guide and cited evidence. Free preview.",
      keywords: ["guidance", "outlook", "raise", "cut", "beat", "miss"] }), headless: guidanceHeadless },
  ],
};
