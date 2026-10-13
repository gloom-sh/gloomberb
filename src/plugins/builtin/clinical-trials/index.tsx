import type { GloomPlugin, PaneTemplateCreateOptions } from "../../../types/plugin";
import { normalizeTrialFilters, TRIAL_REPORT_OPTIONS, ALL } from "./model";
import { TrialsPane } from "./pane";
import { CLINICAL_TRIALS_PANE_ID, CLINICAL_TRIALS_PLUGIN_ID } from "./types";

function createTrialsPaneInstance(options?: PaneTemplateCreateOptions) {
  // A search, never a ticker: a symbol is not a sponsor name and would match unrelated text.
  const query = (options?.arg ?? options?.values?.query ?? "").trim();
  const encoded = encodeURIComponent(query).replace(/%/g, "~");
  // Filters a caller names (a share, the Remote API) open with the pane; they
  // are what it shows first, not which window it is, so the id stays the query's.
  const filters = normalizeTrialFilters(options?.values ?? {});
  const named = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ALL));
  return {
    instanceId: query ? `trials:${encoded}` : "trials:latest",
    title: query ? `Trials ${query}` : "Trials",
    placement: "floating" as const,
    binding: { kind: "none" as const },
    settings: { query, ...named },
  };
}

export const clinicalTrialsPlugin: GloomPlugin = {
  id: CLINICAL_TRIALS_PLUGIN_ID,
  name: "Clinical Trials",
  version: "1.0.0",
  description:
    "Track clinical trials from ClinicalTrials.gov. Search by condition, drug, or sponsor with phase and status.",
  toggleable: true,

  // Study search is a public JSON API, so every renderer. The host is
  // declared so the web app proxies clinicaltrials.gov.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["clinicaltrials.gov"],

  panes: [
    {
      id: CLINICAL_TRIALS_PANE_ID,
      reportFreshness: { source: "ClinicalTrials.gov", status: "not-a-feed", basis: "registry records" },
      reportOptions: TRIAL_REPORT_OPTIONS,
      name: "Trials",
      icon: "C",
      component: TrialsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: "trials-pane",
      paneId: CLINICAL_TRIALS_PANE_ID,
      label: "Clinical Trials",
      description:
        "Search ClinicalTrials.gov studies by condition, drug, or sponsor. Filter by status, phase and sponsor class; listed sponsors show their ticker.",
      keywords: [
        "clinical",
        "trial",
        "trials",
        "clinicaltrials",
        "nct",
        "fda",
        "drug",
        "pharma",
        "sponsor",
        "study",
        "recruiting",
        "phase",
      ],
      shortcut: {
        prefix: "TRIAL",
        argPlaceholder: "condition, drug, or sponsor",
        argKind: "text",
        argOptional: true,
      },
      createInstance(_context, options) {
        return createTrialsPaneInstance(options);
      },
    },
  ],
};
