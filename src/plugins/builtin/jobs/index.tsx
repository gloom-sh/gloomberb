import { publicTickerBindingSymbol } from "../../../tickers/selection";
import type { PluginModule } from "../plugin-module";
import { resetJobsCache } from "./client";
import { jobsHeadless } from "./headless";
import { JOBS_PANE_ID, JobsPane, JobsResearchTab } from "./pane";

export { jobsHeadless } from "./headless";

const description =
  "Hiring read from the company's own careers system: open roles over time, by function and location, new roles, pay ranges. Alone, every covered company ranked.";

function explicitSymbol(options?: { arg?: string; symbol?: string | null }): string | null {
  const symbol = (options?.symbol ?? options?.arg ?? "").trim().toUpperCase();
  return symbol || null;
}

export const jobsModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "jobs",
      name: "Hiring",
      order: 37,
      component: JobsResearchTab,
      instruments: ["equity"],
    });
  },

  dispose() {
    resetJobsCache();
  },

  panes: [
    {
      id: JOBS_PANE_ID,
      name: "Hiring",
      icon: "J",
      component: JobsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 34 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: "jobs-pane",
      paneId: JOBS_PANE_ID,
      label: "Hiring",
      description,
      keywords: ["jobs", "hiring", "headcount", "careers", "openings", "roles", "recruiting", "layoffs", "workforce", "hire"],
      // The ticker is optional on purpose: JOBS alone is the coverage table,
      // and it must not silently bind to whatever ticker happens to be active.
      shortcut: { prefix: "JOBS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
      headless: jobsHeadless,
      createInstance: (_context, options) => {
        const symbol = explicitSymbol(options);
        if (!symbol) {
          return { instanceId: "jobs:home", title: "Hiring", placement: "floating" };
        }
        return {
          instanceId: `jobs:${encodeURIComponent(symbol).replace(/%/g, "~")}`,
          title: `JOBS ${symbol}`,
          binding: { kind: "fixed", symbol },
          placement: "floating",
        };
      },
      publicShare: {
        serialize: ({ pane }) => pane.binding?.kind === "fixed" && publicTickerBindingSymbol(pane.binding)
          ? {
            title: pane.title?.trim() || `JOBS ${pane.binding.symbol}`,
            data: { symbol: publicTickerBindingSymbol(pane.binding)! },
          }
          : null,
        restore: (data) => {
          if (Object.keys(data).length !== 1 || typeof data.symbol !== "string") return null;
          const symbol = data.symbol.trim().toUpperCase();
          return symbol ? { symbol, instrument: null } : null;
        },
      },
    },
  ],
};
