import type { PluginModule } from "../plugin-module";
import { futuresCurveCache } from "./client";
import { futuresCurveHeadless } from "./headless";
import { CURVE_ROOTS, normalizeCurveRoot } from "./model";
import { FuturesCurvePane } from "./pane";

export const futuresCurveModule: PluginModule = {
  panes: [{ id: "futures-curve", name: "Futures Curve", icon: "F", component: FuturesCurvePane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 98, height: 30 },
    tableExport: true, headless: futuresCurveHeadless,
    settings: (context) => ({ title: "Futures Curve Settings",
      values: { root: context.settings.root ?? context.pane.params?.root ?? "ES" },
      fields: [{ key: "root", label: "Contract root", type: "select", options: CURVE_ROOTS }],
    }),
  }],
  paneTemplates: [{ id: "futures-curve-pane", paneId: "futures-curve", label: "Futures Curve",
    description: "Listed futures contracts, historical curves, roll yield and open interest including VIX futures.",
    keywords: ["ctm", "futures", "curve", "contango", "backwardation", "roll", "vix"],
    shortcut: { prefix: "CTM", argKind: "text", argPlaceholder: "root", argOptional: true },
    headless: futuresCurveHeadless,
    createInstance: (context, options) => {
      const input = options?.arg?.trim();
      const root = input ? normalizeCurveRoot(input) : normalizeCurveRoot(context.activeTicker) ?? "ES";
      return { title: `CTM ${root ?? input}`, params: { root: root ?? input ?? "ES" }, placement: "floating" };
    },
  }],
  setup(ctx) { futuresCurveCache.attach(ctx.persistence); },
  dispose() { futuresCurveCache.reset(); },
};
