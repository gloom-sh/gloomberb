import type { GloomPlugin } from "../../../types/plugin";
import { createQueryPaneTemplate } from "../shared/ticker-surface";
import { OPENFDA_DATASETS, OPENFDA_PANE_ID, OPENFDA_PLUGIN_ID } from "./types";

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
      // The pane's Dataset control, for a report: drug reports unless told otherwise.
      reportOptions: [{ key: "dataset", type: "enum", placeholder: "dataset",
        values: OPENFDA_DATASETS.map(({ value }) => ({ value, aliases: [`${value}s`] })),
        description: "Drug adverse event reports (default), device adverse event reports or drug recalls", example: "--dataset device" }],
      name: "FDA Reports",
      icon: "F",
      get component(): typeof import("./pane").OpenFdaPane { const { OpenFdaPane } = require("./pane"); return OpenFdaPane; },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    createQueryPaneTemplate({
      id: "adverse-events-pane",
      paneId: OPENFDA_PANE_ID,
      label: "FDA Reports",
      description: "Drug and device adverse event reports and drug recalls, by drug, device, or firm name.",
      keywords: ["fda", "openfda", "adverse", "recall", "drug", "device", "faers", "side effect", "safety"],
      shortcut: "FDA",
      argPlaceholder: "drug, device or firm",
      instancePrefix: "fda",
      defaultTitle: "FDA Reports",
      titlePrefix: "FDA",
    }),
  ],
};
