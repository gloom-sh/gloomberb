import type { PaneTemplateContext, PaneTemplateDef } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { optionsPositioningHeadless } from "./headless";
import { isPositioningTab } from "./model";
import { OptionsPositioningPane } from "./pane";

/** The underlying OPX opens on when no ticker is active. */
const DEFAULT_UNDERLYING = "SPY";

const tickerTemplate = createTickerSurfacePaneTemplate({
  id: "options-positioning-pane",
  paneId: "options-positioning",
  label: "Options Positioning",
  description: "Open interest by strike and expiry, max pain, and dealer gamma (GEX).",
  keywords: ["opx", "open interest", "max pain", "gex", "gamma", "dealer gamma", "put call", "expiry", "options"],
  shortcut: "OPX",
  shortcutAliases: ["GEX", "MAXPAIN"],
  publicShare: true,
  settings: (_symbol, _context, options) => ({
    ...(isPositioningTab(options?.values?.tab) ? { tab: options!.values!.tab } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(options?.values?.expiry ?? "") ? { expiry: options!.values!.expiry } : {}),
  }),
});
const withDefault = (context: PaneTemplateContext): PaneTemplateContext =>
  context.activeTicker ? context : { ...context, activeTicker: DEFAULT_UNDERLYING };

const optionsPositioningTemplate: PaneTemplateDef = {
  ...tickerTemplate,
  canCreate: (context, options) => tickerTemplate.canCreate?.(withDefault(context), options) ?? true,
  createInstance: (context, options) => tickerTemplate.createInstance?.(withDefault(context), options) ?? null,
  headless: optionsPositioningHeadless,
};

export const optionsPositioningModule: PluginModule = {
  panes: [{
    id: "options-positioning",
    name: "Options Positioning",
    icon: "O",
    component: OptionsPositioningPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 104, height: 34 },
    tableExport: true,
  }],
  paneTemplates: [optionsPositioningTemplate],
};
