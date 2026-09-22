import type { PluginModule } from "../plugin-module";
import { cotBoardCache } from "./client";
import { cotHeadless } from "./headless";
import { cotContractCode } from "./model";
import { CotPane } from "./pane";

export const cotModule: PluginModule = {
  panes: [{ id: "cot", name: "CFTC Positioning", icon: "P", component: CotPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 106, height: 30 },
    tableExport: true, headless: cotHeadless }],
  paneTemplates: ["COT", "CFTC"].map((prefix) => ({ id: `cot-${prefix.toLowerCase()}`, paneId: "cot", label: "CFTC Positioning",
    description: "Weekly futures positioning, changes, historical percentiles and cross-market extremes.",
    keywords: ["cot", "cftc", "positioning", "commitments", "managed money", "net spec"],
    shortcut: { prefix, argKind: "text" as const, argPlaceholder: "code or root", argOptional: true }, headless: cotHeadless,
    createInstance: (context, options) => {
      const input = options?.arg?.trim();
      const code = cotContractCode(input || context.activeTicker);
      if (input && !code) throw new Error("Use a CFTC market code or supported futures root");
      return { title: code ? `COT ${code}` : "CFTC Positioning", params: code ? { code } : undefined,
        settings: { report: options?.values?.report ?? "legacy" }, placement: "floating" as const };
    },
  })),
  setup(ctx) { cotBoardCache.attach(ctx.persistence); },
  dispose() { cotBoardCache.reset(); },
};
