import type { GloomPlugin, PaneTemplateCreateOptions } from "../../../types/plugin";
import { OpenFdaPane } from "./pane";
import { OPENFDA_PANE_ID, OPENFDA_PLUGIN_ID } from "./types";

const createOpenFdaPaneInstance = (options?: PaneTemplateCreateOptions) => {
  // A search of product and firm names, never a ticker: FDA records name the
  // firm as it filed, not a symbol, so a ticker would match unrelated text.
  const query = (options?.arg ?? options?.values?.query ?? "").trim();
  const encoded = encodeURIComponent(query).replace(/%/g, "~");
  return {
    instanceId: query ? `fda:${encoded}` : "fda:latest",
    title: query ? `FDA ${query}` : "FDA Reports",
    placement: "floating" as const,
    binding: { kind: "none" as const },
    settings: { query },
  };
};

export const openFdaPlugin: GloomPlugin = {
  id: OPENFDA_PLUGIN_ID,
  name: "FDA Reports and Recalls",
  version: "1.0.0",
  description:
    "FDA adverse event reports for drugs and devices, and drug recalls, from openFDA. Search by drug, device, or firm name.",
  toggleable: true,

  // Public JSON over HTTPS, so every renderer. The host is declared so the web app proxies api.fda.gov.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["api.fda.gov"],

  panes: [
    {
      id: OPENFDA_PANE_ID,
      reportFreshness: { source: "US FDA", status: "not-a-feed", basis: "published reports" },
      name: "FDA Reports",
      icon: "F",
      component: OpenFdaPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: "adverse-events-pane",
      paneId: OPENFDA_PANE_ID,
      label: "FDA Reports",
      description:
        "Drug and device adverse event reports and drug recalls, by drug, device, or firm name.",
      keywords: [
        "fda",
        "openfda",
        "adverse",
        "recall",
        "drug",
        "device",
        "faers",
        "side effect",
        "safety",
      ],
      shortcut: {
        prefix: "FDA",
        argPlaceholder: "drug, device or firm",
        argKind: "text",
        argOptional: true,
      },
      createInstance: (_context, options) => createOpenFdaPaneInstance(options),
    },
  ],
};
