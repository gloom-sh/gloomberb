import type { PluginModule } from "../plugin-module";
import { futuresCurveCache } from "./client";
import { futuresCurveHeadless } from "./headless";
import { BASIS_FORMULA, CURVE_HORIZONS, CURVE_ROOTS, curveRootForTicker, curveTitle, DEFAULT_CURVE_HORIZON, normalizeCurveRoot } from "./model";

export const futuresCurveModule: PluginModule = {
  panes: [{ id: "futures-curve", name: "Futures Curve", icon: "F", get component(): typeof import("./pane").FuturesCurvePane { const { FuturesCurvePane } = require("./pane"); return FuturesCurvePane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 98, height: 30 },
    tableExport: true, headless: futuresCurveHeadless,
    settings: (context) => ({ title: "Futures Curve Settings",
      values: { root: context.settings.root ?? context.pane.params?.root ?? "ES", horizon: context.settings.horizon ?? DEFAULT_CURVE_HORIZON },
      fields: [
        { key: "root", label: "Contract root", type: "select", options: CURVE_ROOTS },
        { key: "horizon", label: "Chart horizon", type: "select", options: [...CURVE_HORIZONS] },
      ],
    }),
  }],
  paneTemplates: [{ id: "futures-curve-pane", paneId: "futures-curve", label: "Futures Curve",
    description: `Listed futures contracts, historical curves, roll yield and open interest including VIX and CME crypto futures, which add basis against spot: Ann Basis = ${BASIS_FORMULA}, simple actual/365.`,
    keywords: ["ctm", "futures", "curve", "term structure", "contango", "backwardation", "roll", "basis", "basis trade", "carry", "annualised basis", "vix", "crude oil", "natural gas"],
    shortcut: { prefix: "CTM", aliases: ["CT"], argKind: "text", argPlaceholder: "root", argOptional: true,
      argOptions: () => CURVE_ROOTS },
    headless: futuresCurveHeadless,
    createInstance: (context, options) => {
      const input = options?.arg?.trim();
      const root = input ? normalizeCurveRoot(input) : curveRootForTicker(context.activeTicker) ?? "ES";
      return { title: root ? curveTitle(root) : `CTM ${input}`, params: { root: root ?? input ?? "ES" }, placement: "floating" };
    },
  }],
  setup(ctx) { futuresCurveCache.attach(ctx.persistence); },
  dispose() { futuresCurveCache.reset(); },
};
