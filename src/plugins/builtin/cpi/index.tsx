import type { PaneTemplateCreateOptions, PaneTemplateInstanceConfig } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { cpiBoardCache } from "./client";
import { cpiHeadless } from "./headless";
import { CPI_ROW_OPTIONS, cpiRowOption } from "./model";
import { CpiPane } from "./pane";

/** Opens on the table, or on the component typed after the mnemonic. */
function cpiInstance(options?: PaneTemplateCreateOptions): PaneTemplateInstanceConfig {
  const input = options?.arg?.trim();
  const row = cpiRowOption(input);
  if (input && !row) throw new Error("Use a component such as shelter, core, gasoline or supercore");
  return { placement: "floating", ...(row ? { params: { row: row.value } } : {}) };
}

export const cpiModule: PluginModule = {
  panes: [{ id: "cpi", name: "US Consumer Prices", icon: "C", component: CpiPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 100, height: 36 },
    tableExport: true, headless: cpiHeadless }],
  paneTemplates: [{
    id: "cpi-pane", paneId: "cpi", label: "US Consumer Prices",
    description: "The US consumer price index by component: weights, monthly, annualised and yearly changes, and contributions to the headline.",
    keywords: ["cpi", "ecan", "inflation", "consumer prices", "bls", "core", "shelter", "supercore", "rent", "gasoline"],
    shortcut: { prefix: "CPI", aliases: ["ECAN"], argKind: "text", argPlaceholder: "component", argOptional: true,
      argOptions: () => CPI_ROW_OPTIONS.map(({ value, label }) => ({ value, label })) },
    headless: cpiHeadless,
    createInstance: (_context, options) => cpiInstance(options),
  }],
  setup(ctx) { cpiBoardCache.attach(ctx.persistence); },
  dispose() { cpiBoardCache.reset(); },
};
