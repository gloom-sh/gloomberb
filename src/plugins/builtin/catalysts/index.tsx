import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { catalystCache, catalystDetailCache } from "./client";
import { catalystsHeadless, litigationHeadless } from "./headless";
import { CatalystsPane, CatalystView, LitigationPane } from "./pane";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import type { TickerResearchTabProps } from "../../../types/plugin";

function ResearchCatalysts(props: TickerResearchTabProps) {
  const { symbol } = usePaneTickerIdentity();
  return <CatalystView key={symbol ?? "market"} {...props} symbol={symbol} />;
}
export const catalystsModule: PluginModule = {
  setup(ctx) {
    for (const cache of [catalystCache, catalystDetailCache]) cache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({ id: "catalysts", name: "Catalysts", order: 35, component: ResearchCatalysts, instruments: ["equity"] });
  },
  dispose() { catalystCache.reset(); catalystDetailCache.reset(); },
  panes: [
    { id: "catalysts", name: "Catalysts", icon: "C", component: CatalystsPane, defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 130, height: 32 }, tableExport: true, headless: catalystsHeadless },
    { id: "litigation", name: "Litigation", icon: "L", component: LitigationPane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 120, height: 30 }, tickerFollower: true, tableExport: true, headless: litigationHeadless },
  ],
  paneTemplates: [
    { id: "catalysts-pane", paneId: "catalysts", label: "Catalysts", description: "Pro regulatory, clinical, legal and trade-policy calendar with source evidence and revision history.", keywords: ["catalysts", "calendar", "FDA", "clinical", "regulatory", "deadlines", "antitrust", "sanctions"],
      shortcut: { prefix: "CATL", argKind: "ticker", argPlaceholder: "ticker", argOptional: true, openWithoutArg: true }, headless: catalystsHeadless,
      createInstance: (_context, options) => { const symbol = (options?.symbol ?? options?.arg ?? "").trim().toUpperCase(); const event = options?.values?.event; const open = event && /^[a-zA-Z0-9:_-]{1,160}$/.test(event) ? event : undefined; return { title: symbol ? `CATL ${symbol}` : "Catalysts", placement: "floating", ...(symbol ? { binding: { kind: "fixed" as const, symbol } } : {}), settings: { symbol, ...(open ? { open } : {}) } }; } },
    { ...createTickerSurfacePaneTemplate({ id: "litigation-pane", paneId: "litigation", label: "Litigation", description: "Pro company litigation, enforcement and antitrust dockets with dated source evidence.", keywords: ["litigation", "legal", "docket", "court", "enforcement", "antitrust"], shortcut: "LITI" }), headless: litigationHeadless },
  ],
};
