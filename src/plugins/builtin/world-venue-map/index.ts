import { peekGeoCatalog } from "../../../api-client/geo";
import { CHART_COMPOSER_PANE_ID } from "../../../types/config";
import type { PaneTemplateDef } from "../../../types/plugin";
import { chartHeadless } from "../chart-composer/headless";
import type { PluginModule } from "../plugin-module";
import { createChokepointInstance } from "./chokepoint-chart";
import { withTransitAverages } from "./chokepoint-report";
import { cloudGeoRequest } from "./client";
import { ACTIVITY_SERIES } from "./activity-series";
import { CHOKEPOINT_SERIES, createGeoChartSeriesCapability } from "./geo-series";
import { contextGeoRequest, mapHeadless } from "./headless";
import { buildMapSettingsDef, groupTitle, MAP_PRESET_OPTIONS, parseMapPreset } from "./layers";
import { WORLD_VENUE_MAP_PANE_ID, WorldVenueMapPane } from "./pane";
import { mapFollowsTicker } from "./scope";
import { mapHomeArea, paneWithoutHomeArea } from "./place";

const chartComposerHeadless = chartHeadless("chart-composer-pane");

const chokepointTemplate: PaneTemplateDef = {
  id: "chokepoint-chart-pane",
  paneId: CHART_COMPOSER_PANE_ID,
  headless: {
    ...chartComposerHeadless,
    description: "Daily vessel transits through the main shipping chokepoints, or one chokepoint by name, with 7- and 28-day averages and the change on the same 28 days a year before.",
    load: async (args, context) => withTransitAverages(await chartComposerHeadless.load(args, context), contextGeoRequest(context), context),
    // Keeps the chart composer's id, which its screenshot is read by, and says what it charts: vessel transits, not FRED series.
    discovery: {
      ...chartComposerHeadless.discovery,
      aliases: ["chokepoint transits", "shipping chokepoints"],
      limitations: [
        "Transit counts are estimates from ships' position reports (AIS), published weekly a few days after the ships pass; the latest weeks can be revised.",
        "A ship that turns off its transponder is not counted.",
      ],
    },
  },
  label: "Chokepoint Transits",
  description: "Chart daily vessel transits through the main shipping chokepoints, or one of them.",
  keywords: ["chokepoint", "chokepoints", "transits", "suez", "panama", "hormuz", "malacca", "shipping", "strait", "canal"],
  shortcut: { prefix: "CHOKE", argPlaceholder: "chokepoint", argKind: "text", argOnlySelects: true, argOptional: true },
  canCreate: () => true,
  catalogSettings: {},
  createInstance: (_context, options) => createChokepointInstance(cloudGeoRequest, options?.arg),
};

/** The home area a share is checked against, read from the running app's config. */
let currentHomeArea = (): string => "";

export const worldVenueMapModule: PluginModule = {
  setup: (ctx) => {
    currentHomeArea = () => mapHomeArea(ctx.getConfig());
  },
  dispose: () => {
    currentHomeArea = () => "";
  },
  panes: [
    {
      id: WORLD_VENUE_MAP_PANE_ID,
      name: "World Map",
      icon: "M",
      component: WorldVenueMapPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 124, height: 36 },
      // Linked to a list, a map with the app's own layers (facilities) shows the selected company's.
      shareItem: { ticker: true, argument: true },
      tickerFollower: mapFollowsTicker,
      // Maps made before the home area was read when a map opens stored it as their place.
      portableShare: { prepare: (pane) => paneWithoutHomeArea(pane, currentHomeArea()) },
      settings: (context) => buildMapSettingsDef(context.settings, peekGeoCatalog()?.layers),
    },
  ],
  paneTemplates: [
    {
      id: "world-venue-map-pane",
      paneId: WORLD_VENUE_MAP_PANE_ID,
      label: "World Map",
      description: "A world map with trading venues and their hours; ships, ports, energy, airports and AI buildout facilities as layers.",
      keywords: ["world", "map", "globe", "countries", "venue", "venues", "exchange", "mic", "market hours", "open markets", "ships", "ship", "vessels", "vessel", "shipping", "ais", "ports", "port", "chokepoints", "pipelines", "airports", "energy", "facilities", "data centers", "fabs", "layers"],
      shortcut: {
        prefix: "MAP",
        argPlaceholder: "layers [place or lat,lon]",
        argKind: "text", argOnlySelects: true,
        argOptional: true,
        argOptions: () => MAP_PRESET_OPTIONS,
      },
      headless: mapHeadless,
      createInstance: (_context, options) => {
        const preset = parseMapPreset(options?.arg ?? options?.values?.layers, peekGeoCatalog()?.layers);
        // Only a place that was typed is kept: the home area is read when the map opens, so a saved or shared map never carries it.
        const place = preset?.place;
        if (!preset) return { placement: "floating" };
        return {
          title: `${preset.layers.length ? `Map · ${preset.layers.map(groupTitle).join(", ")}` : "Map · Venues"}${place ? ` · ${place}` : ""}`,
          placement: "floating",
          settings: { layers: preset.layers, venues: preset.venues, ...(place ? { place } : {}) },
        };
      },
    },
    chokepointTemplate,
  ],
  capabilities: [createGeoChartSeriesCapability()],
  series: [...CHOKEPOINT_SERIES, ...ACTIVITY_SERIES],
};
