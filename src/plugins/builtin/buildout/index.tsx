import { BuildoutPane } from "./pane";
import { BUILDOUT_COMPANY_PANE_ID, BuildoutCompanyPane } from "./company/pane";
import { facilitiesLayer } from "./facilities";
import type { PluginModule } from "../plugin-module";
import type { PaneReportOptionDef } from "../../../types/plugin";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { registerLocalGeoLayer } from "../world-venue-map/local-layers";

let removeFacilities: (() => void) | null = null;

/** Which view the company pane opens on: a desk opens one on its signals. */
const COMPANY_TAB_OPTION: PaneReportOptionDef = {
  key: "tab",
  type: "enum",
  description: "The view to open on: the flow of deals, suppliers and customers, the sites, hiring by site or the signals.",
  values: [{ value: "flow" }, { value: "sites" }, { value: "hiring" }, { value: "signals" }],
  example: "--tab signals",
};

export const buildoutModule: PluginModule = {
  // Facilities join the world map's layers for as long as the plugin is on.
  setup() {
    removeFacilities?.();
    removeFacilities = registerLocalGeoLayer(facilitiesLayer);
  },
  dispose() {
    removeFacilities?.();
    removeFacilities = null;
  },
  panes: [{
    id: "buildout",
    reportFreshness: { status: "not-a-feed", basis: "infrastructure research" },
    name: "TheBuildout",
    icon: "T",
    component: BuildoutPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 34 },
    // The company under the cursor, for linked panes: its flow, a chart, a map of its sites.
    tickerSource: true,
  }, {
    id: BUILDOUT_COMPANY_PANE_ID,
    reportFreshness: { status: "not-a-feed", basis: "disclosed relationships" },
    // Short, since a linked pane's title adds the ticker and what it follows.
    name: "Buildout",
    icon: "T",
    component: BuildoutCompanyPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 120, height: 32 },
    tickerFollower: true,
    instruments: ["equity"],
    reportOptions: [COMPANY_TAB_OPTION],
  }],
  paneTemplates: [{
    id: "buildout-pane",
    paneId: "buildout",
    label: "TheBuildout",
    description: "Open TheBuildout infrastructure intelligence: themes, companies, sites and intel.",
    keywords: ["tbo", "buildout", "thebuildout", "infrastructure", "themes", "sites", "intel"],
    shortcut: { prefix: "TBO" },
    createInstance: () => ({ placement: "floating" }),
  }, createTickerSurfacePaneTemplate({
    id: "buildout-company-pane",
    paneId: BUILDOUT_COMPANY_PANE_ID,
    label: "TheBuildout Company",
    description: "One company in TheBuildout: its power and hosting deals, suppliers and customers as a flow, its sites, hiring by site and the signals that name it.",
    keywords: ["tboc", "buildout", "thebuildout", "power deals", "data centers", "sites", "suppliers", "customers", "signals"],
    shortcut: "TBOC",
  })],
};
