import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { traceBondsHeadless } from "./headless";
import { TRACE_BONDS_PANE_ID } from "./model";

function createTraceBondsInstance(options?: PaneTemplateCreateOptions) {
  const issuer = (options?.arg ?? "").trim();
  const encoded = encodeURIComponent(issuer).replace(/%/g, "~");
  return {
    instanceId: issuer ? `trace-bonds:${encoded}` : "trace-bonds",
    placement: "floating" as const,
    binding: { kind: "none" as const },
    ...(issuer ? { params: { issuer } } : {}),
  };
}

export const traceBondsModule: PluginModule = {
  paneTemplates: [
    {
      ...fixedIncomeShortcut({
        id: "trace-bonds-pane",
        paneId: TRACE_BONDS_PANE_ID,
        label: "Corporate Bond Tape",
        description: "Latest corporate and agency bond sales: issuer, coupon, price, yield, and grade.",
        keywords: ["bond", "bonds", "corporate", "agency", "coupon", "yield", "issuer", "cusip", "credit", "fixed income", "trace"],
        shortcut: { prefix: "TRACE", argKind: "text", argOptional: true, argPlaceholder: "issuer, symbol or CUSIP" },
        headless: traceBondsHeadless,
        createInstance: (_context, options) => createTraceBondsInstance(options),
      }, "bonds", "tape"),
    },
  ],
};
