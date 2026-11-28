import type { PluginModule } from "../plugin-module";
import { createOptionalTickerPaneTemplate } from "../shared/ticker-surface";
import { JOBS_SERIES } from "./series";
import { resetJobsCache } from "./client";
import { jobsHeadless } from "./headless";
import { jobsLockNote } from "./lock-note";
import { JOBS_PANE_ID, JobsPane, JobsResearchTab } from "./pane";

const description =
  "Pro hiring read from the company's own careers system: open roles over time, by function and location, new roles, pay ranges. Alone, every covered company ranked.";

export const jobsModule: PluginModule = {
  series: JOBS_SERIES,
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "jobs",
      name: "Hiring",
      order: 37,
      component: JobsResearchTab,
      instruments: ["equity"],
      proOnly: true,
    });
  },

  dispose() {
    resetJobsCache();
  },

  panes: [
    {
      id: JOBS_PANE_ID,
      reportLockNote: jobsLockNote,
      name: "Hiring",
      icon: "J",
      component: JobsPane,
      defaultPosition: "right",
      shareItem: { ticker: true },
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 34 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    // The ticker is optional on purpose: JOBS alone is the coverage table,
    // and it must not silently bind to whatever ticker happens to be active.
    createOptionalTickerPaneTemplate({
      id: "jobs-pane",
      paneId: JOBS_PANE_ID,
      label: "Hiring",
      description,
      keywords: ["jobs", "hiring", "headcount", "careers", "openings", "roles", "recruiting", "layoffs", "workforce", "hire"],
      shortcut: "JOBS",
      instancePrefix: "jobs",
      emptyInstance: { instanceId: "jobs:home", title: "Hiring", placement: "floating" },
      headless: jobsHeadless,
      publicShare: true,
    }),
  ],
};
