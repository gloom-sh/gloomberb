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
import { ThirteenFTickerPane } from "./signals-pane";
import { isKnownNonUsListing } from "../../../utils/sec";


function queryFromOptions(options?: PaneTemplateCreateOptions): string {
  return (options?.arg ?? options?.values?.query ?? "").trim();
}

function initialCikFromQuery(query: string): string | undefined {
  return isCikQuery(query) ? query.padStart(10, "0") : undefined;
}

export const thirteenFModule: PluginModule = {
  setup(ctx) {
    attachThirteenFApiPersistence(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "thirteenf",
      name: "13F",
      order: 39,
      component: ThirteenFTickerPane,
      instruments: ["equity", "fund"],
      isVisible: ({ ticker }) => !isKnownNonUsListing(ticker),
    });
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
          // The title bar already shows the Funds tab, so the bare pane is just "13F".
          title: query ? `13F ${query}` : "13F",
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
