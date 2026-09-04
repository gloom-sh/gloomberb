import type { PaneTemplateCreateOptions, PaneTemplateContext } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import {
  THIRTEENF_PANE_ID,
  THIRTEENF_TEMPLATE_ID,
  inferBrowserTabFromQuery,
  isCikQuery,
} from "./model";
import { ThirteenFPane } from "./pane";
import {
  attachThirteenFApiPersistence,
  resetThirteenFApiPersistence,
} from "./api";
import { thirteenFHeadless } from "./headless";

export { thirteenFHeadless } from "./headless";

function queryFromOptions(options?: PaneTemplateCreateOptions): string {
  return (options?.arg ?? options?.values?.query ?? "").trim();
}

function initialCikFromQuery(query: string): string | undefined {
  return isCikQuery(query) ? query.padStart(10, "0") : undefined;
}

export const thirteenFModule: PluginModule = {
  setup(ctx) {
    attachThirteenFApiPersistence(ctx.persistence);
  },

  dispose() {
    resetThirteenFApiPersistence();
  },

  panes: [
    {
      id: THIRTEENF_PANE_ID,
      name: "13F Funds",
      icon: "13F",
      component: ThirteenFPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 112, height: 36 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: THIRTEENF_TEMPLATE_ID,
      paneId: THIRTEENF_PANE_ID,
      label: "13F Funds",
      description: "Browse institutional 13F fund filings and estimated long-book performance.",
      keywords: ["13f", "funds", "hedge funds", "holdings", "filings", "institutional"],
      shortcut: {
        prefix: "13F",
        argPlaceholder: "fund, ticker, or CIK",
        argKind: "text",
        argOptional: true,
      },
      headless: thirteenFHeadless,
      createInstance(_context: PaneTemplateContext, options?: PaneTemplateCreateOptions) {
        const query = queryFromOptions(options);
        const browserMode = inferBrowserTabFromQuery(query);
        const initialCik = options?.values?.cik || initialCikFromQuery(query);
        return {
          instanceId: initialCik
            ? `${THIRTEENF_PANE_ID}:${initialCik}`
            : `${THIRTEENF_PANE_ID}:${browserMode}:${encodeURIComponent(query || "performance").replace(/%/g, "~")}`,
          title: query ? `13F ${query}` : "13F Funds",
          placement: "floating",
          settings: {
            query,
            initialCik,
          },
        };
      },
    },
  ],
};
