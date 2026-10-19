import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { SINGLE_NAME_CDS_SERIES } from "./series";
import { CDS_PANE_ID } from "./model";
import { cdsHeadless } from "./headless";


/** Only an explicit argument binds a ticker; bare `CDS` stays market-wide. */
function explicitSymbol(options?: PaneTemplateCreateOptions): string | null {
  const raw = options?.symbol ?? options?.ticker?.metadata.ticker ?? options?.arg;
  return raw?.trim().toUpperCase() || null;
}

export const cdsModule: PluginModule = {
  series: SINGLE_NAME_CDS_SERIES,
  paneTemplates: [{
    ...fixedIncomeShortcut({
      id: "cds-pane",
      paneId: CDS_PANE_ID,
      label: "Single-Name CDS",
      description: "Single-name corporate CDS from DTCC public dissemination: with no argument, the issuers traded in the last 5 days with their 5Y spread and its 1W and 1M moves, ranked by any column (fn CDS --sort 1m); with a ticker or issuer, its 5Y spread history, trades and daily levels (fn CDS F --csv --section daily exports them).",
      keywords: ["cds", "credit", "default", "swap", "spread", "single name", "issuer", "dtcc", "protection"],
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
    }, "credit", "single-name"),
  }],
};
