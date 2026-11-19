import type { PluginModule } from "../plugin-module";
import { cotBoardCache } from "./client";
import { cotHeadless } from "./headless";
import { COT_ROOT_OPTIONS, cotContractCode, cotContractCodeForTicker, cotDefaultFamily, cotProxyFor, cotRoot, cotUnknownMarketMessage } from "./model";
import { COT_SERIES } from "./series";

export const cotModule: PluginModule = {
  series: COT_SERIES,
  panes: [{ id: "cot", name: "Trader Positioning", icon: "P", shareItem: { argument: true }, get component(): typeof import("./pane").CotPane { const { CotPane } = require("./pane"); return CotPane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 106, height: 30 },
    tableExport: true, headless: cotHeadless }],
  paneTemplates: [{ id: "cot-cot", paneId: "cot", label: "Trader Positioning",
    description: "Weekly futures positioning, changes, historical percentiles and cross-market extremes.",
    keywords: ["cot", "cftc", "positioning", "commitments", "managed money", "net spec", "crude oil", "natural gas", "brent", "gasoil", "ICE Europe"],
    shortcut: { prefix: "COT", aliases: ["CFTC"], argKind: "text" as const, argOnlySelects: true, argPlaceholder: "code or name", argOptional: true,
      argOptions: () => COT_ROOT_OPTIONS }, headless: cotHeadless,
    createInstance: (context, options) => {
      const input = options?.arg?.trim();
      const code = input ? cotContractCode(input) : cotContractCodeForTicker(context.activeTicker);
      if (input && !code) throw new Error(cotUnknownMarketMessage(input));
      // "jet fuel" opens heating oil, and the title says which market stands in.
      const proxy = input ? cotProxyFor(input) : null;
      return { title: code ? `COT ${cotRoot(code) ?? code}${proxy ? ` (${proxy.subject} proxy)` : ""}` : "Trader Positioning", params: code ? { code, cotReport: String(options?.values?.report ?? cotDefaultFamily(code)) } : undefined,
        settings: { report: options?.values?.report ?? cotDefaultFamily(code) }, placement: "floating" as const };
    },
  }],
  setup(ctx) { cotBoardCache.attach(ctx.persistence); },
  dispose() { cotBoardCache.reset(); },
};
