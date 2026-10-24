import type { PaneTemplateContext, ShortcutArgError } from "../../../types/plugin";
import { unknownCollectionArgError } from "../../../portfolio/collection-name";
import type { PluginModule } from "../plugin-module";
import { exposureHeadless } from "./headless";
import { ExposurePane } from "./pane";

/** `EXPO PORT:Nope` or `EXPO WATCH:Nope` names a portfolio or watchlist nothing has; tickers and weights are read by the pane. */
function unknownSourceArg(arg: string, context: PaneTemplateContext): ShortcutArgError | null {
  const source = /^(PORT|WATCH):(.+)$/i.exec(arg.trim());
  if (!source) return null;
  const prefix = source[1]!.toUpperCase();
  return prefix === "PORT"
    ? unknownCollectionArgError(source[2]!, context.config.portfolios, "portfolio", (name) => `PORT:${name}`)
    : unknownCollectionArgError(source[2]!, context.config.watchlists, "watchlist", (name) => `WATCH:${name}`);
}

export const exposureModule: PluginModule = {
  panes: [{ id: "exposure", name: "Exposure", icon: "E", component: ExposurePane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 138, height: 31 }, tableExport: true, headless: exposureHeadless,
    personalData: "holdings",
    portableShare: { private: { params: true, settings: true, state: true } } }],
  paneTemplates: [{ id: "exposure-pane", paneId: "exposure", label: "Exposure", description: "Pro scenario exposures across holdings, geographic revenue and supply chains, with source evidence and portfolio concentrations.",
    keywords: ["exposure", "scenario", "stress", "portfolio", "supply", "country", "tariff", "pro"],
    shortcut: { prefix: "EXPO", argKind: "text", argOptional: true, argPlaceholder: "AAPL=60% NVDA=40%", argError: unknownSourceArg }, headless: exposureHeadless,
    createInstance: (_context, options) => ({ params: { input: options?.arg ?? "" } }),
  }],
};
