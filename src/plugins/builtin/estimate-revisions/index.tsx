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
  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "estimate-revisions-em",
        paneId: "estimate-revisions",
        label: "Estimate Revisions",
        description:
          "Consensus EPS changes, analyst revision counts, surprises and cited guidance.",
        keywords: ["estimates", "revisions", "consensus", "em", "eeo"],
        shortcut: "EM",
        shortcutAliases: ["EEO"],
        viewKey: "EM",
        settings: () => ({ tab: "revisions" }),
      }),
      headless: estimateRevisionsHeadless,
    },
    {
      ...createTickerSurfacePaneTemplate({
        id: "estimate-revisions-guid",
        paneId: "estimate-revisions",
        label: "Company Guidance",
        description:
          "Company EPS guidance cited from filings and transcripts, against consensus.",
        keywords: ["guidance", "outlook", "estimates", "guid"],
        shortcut: "GUID",
        viewKey: "GUID",
        settings: () => ({ tab: "guidance" }),
      }),
      headless: estimateRevisionsHeadless,
    },
  ],
  setup(ctx) {
    estimateRevisionsCache.attach(ctx.persistence);
  },
  dispose() {
    estimateRevisionsCache.reset();
  },
};
