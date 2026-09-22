import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { estimateRevisionsCache } from "./client";
import { estimateRevisionsHeadless } from "./headless";
import { EstimateRevisionsPane } from "./pane";
export const estimateRevisionsModule: PluginModule = {
  panes: [
    {
      id: "estimate-revisions",
      name: "Estimate Revisions",
      icon: "E",
      component: EstimateRevisionsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 30 },
      tableExport: true,
      headless: estimateRevisionsHeadless,
      settings: {
        title: "Estimate Revisions",
        fields: [
          {
            key: "period",
            label: "Fiscal end",
            type: "text",
            placeholder: "YYYY-MM-DD",
          },
          {
            key: "frequency",
            label: "Frequency",
            type: "select",
            options: [
              { value: "quarterly", label: "Quarterly" },
              { value: "annual", label: "Annual" },
            ],
          },
          {
            key: "tab",
            label: "View",
            type: "select",
            options: [
              { value: "revisions", label: "Revisions" },
              { value: "surprises", label: "Surprises" },
              { value: "guidance", label: "Guidance" },
            ],
          },
        ],
      },
    },
  ],
  paneTemplates: ["EM", "EEO", "GUID"].map((shortcut) => ({
    ...createTickerSurfacePaneTemplate({
      id: `estimate-revisions-${shortcut.toLowerCase()}`,
      paneId: "estimate-revisions",
      label: "Estimate Revisions",
      description:
        "Consensus EPS changes, analyst revision counts, surprises and cited guidance.",
      keywords: [
        "estimates",
        "revisions",
        "consensus",
        "guidance",
        shortcut.toLowerCase(),
      ],
      shortcut,
      viewKey: shortcut,
      settings: () => ({ tab: shortcut === "GUID" ? "guidance" : "revisions" }),
    }),
    headless: estimateRevisionsHeadless,
  })),
  setup(ctx) {
    estimateRevisionsCache.attach(ctx.persistence);
  },
  dispose() {
    estimateRevisionsCache.reset();
  },
};
