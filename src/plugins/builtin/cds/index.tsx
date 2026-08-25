import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { CDS_PANE_ID } from "./model";
import { CdsPane } from "./pane";

/**
 * Only an explicit argument binds a ticker. `CDS` on its own is the
 * market-wide view, so it must not inherit the focused ticker the way the
 * shared ticker-surface templates do.
 */
function explicitSymbol(options?: PaneTemplateCreateOptions): string | null {
  const raw = options?.symbol ?? options?.ticker?.metadata.ticker ?? options?.arg;
  return raw?.trim().toUpperCase() || null;
}

export const cdsModule: PluginModule = {
  panes: [{
    id: CDS_PANE_ID,
    name: "Single-Name CDS",
    icon: "D",
    component: CdsPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 92, height: 22 },
  }],
  paneTemplates: [{
    id: "cds-pane",
    paneId: CDS_PANE_ID,
    label: "Single-Name CDS",
    description: "Single-name corporate CDS trade activity from DTCC public dissemination.",
    keywords: ["cds", "credit", "default", "swap", "single name", "issuer", "dtcc", "protection"],
    // Deliberately "text": a "ticker" arg would resolve the focused ticker when
    // the argument is omitted, and bare CDS must stay market-wide.
    shortcut: { prefix: "CDS", argPlaceholder: "issuer", argKind: "text", argOptional: true },
    createInstance: (_context, options) => {
      const symbol = explicitSymbol(options);
      return symbol
        ? {
          instanceId: `${CDS_PANE_ID}:${symbol}`,
          title: `CDS ${symbol}`,
          binding: { kind: "fixed", symbol },
          placement: "floating",
        }
        : { instanceId: `${CDS_PANE_ID}:market`, title: "CDS", placement: "floating" };
    },
  }],
};
