import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { CDS_PANE_ID } from "./model";
import { CdsPane } from "./pane";
import { cdsHeadless } from "./headless";

export { cdsHeadless } from "./headless";

/** Only an explicit argument binds a ticker; bare `CDS` stays market-wide. */
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
    shortcut: { prefix: "CDS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
    headless: cdsHeadless,
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
