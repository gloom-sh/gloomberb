import type { PluginModule } from "../plugin-module";
import type { PaneTemplateDef } from "../../../types/plugin";
import { appRankCache, attentionCache, movesCache } from "./client";
import { attentionHeadless } from "./headless";
import { AppsPane, HiringPane } from "./pane";
import { COMPANY_ATTENTION_SERIES } from "./series";

const definitions = [
  { id: "hiring", prefix: "HIRE", label: "Hiring Momentum", component: HiringPane, description: "Pro hiring momentum: observed weekly open roles, additions, removals, role and location mix, peer comparisons, hiring moves against each company's own weeks and peers, and primary posting evidence.", keywords: ["hiring", "workforce", "roles", "recruitment", "surge", "freeze"] },
  { id: "apps", prefix: "APPS", label: "App Attention", component: AppsPane, description: "Pro app attention: public global app ranks, rank velocity, rating drift, company ownership and source evidence.", keywords: ["apps", "app attention", "mobile", "rank", "ratings", "developer"] },
] as const;
const templates: PaneTemplateDef[] = definitions.map((def) => ({
  id: `${def.id}-pane`, paneId: def.id, label: def.label, description: def.description, keywords: [...def.keywords],
  shortcut: { prefix: def.prefix, argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
  headless: attentionHeadless(def.id),
  createInstance: (_context, options) => {
    const symbol = (options?.symbol ?? options?.arg ?? "").trim().toUpperCase();
    return { instanceId: `${def.id}:${symbol ? encodeURIComponent(symbol).replace(/%/g, "~") : "board"}`, title: symbol ? `${def.prefix} ${symbol}` : def.label, ...(symbol ? { binding: { kind: "fixed" as const, symbol } } : {}), placement: "floating" };
  },
}));
export const companyAttentionModule: PluginModule = {
  series: COMPANY_ATTENTION_SERIES,
  setup(ctx) {
    attentionCache.attach(ctx.persistence);
    movesCache.attach(ctx.persistence);
    appRankCache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({ id: "hiring-momentum", name: "Hiring momentum", order: 38, component: HiringPane, instruments: ["equity"] });
    ctx.registerTickerResearchTab({ id: "app-attention", name: "Apps", order: 39, component: AppsPane, instruments: ["equity"] });
  },
  dispose() { attentionCache.reset(); movesCache.reset(); appRankCache.reset(); },
  panes: definitions.map((def) => ({ id: def.id, name: def.label, icon: def.prefix[0]!, component: def.component, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 130, height: 32 }, tickerFollower: true, instruments: ["equity"], tableExport: true, headless: attentionHeadless(def.id) })),
  paneTemplates: templates,
};
