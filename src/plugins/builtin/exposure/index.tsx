import type { PluginModule } from "../plugin-module";
import { exposureHeadless } from "./headless";
import { ExposurePane } from "./pane";

export const exposureModule: PluginModule = {
  panes: [{ id: "exposure", name: "Exposure", icon: "E", component: ExposurePane, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 138, height: 31 }, tableExport: true, headless: exposureHeadless,
    portableShare: { private: { params: true, settings: true, state: true } } }],
  paneTemplates: [{ id: "exposure-pane", paneId: "exposure", label: "Exposure", description: "Pro scenario exposures across holdings, geographic revenue and supply chains, with source evidence and portfolio concentrations.",
    keywords: ["exposure", "scenario", "stress", "portfolio", "supply", "country", "tariff", "pro"],
    shortcut: { prefix: "EXPO", argKind: "text", argOptional: true, argPlaceholder: "AAPL=60% NVDA=40%" }, headless: exposureHeadless,
    createInstance: (_context, options) => ({ params: { input: options?.arg ?? "" } }),
  }],
};
