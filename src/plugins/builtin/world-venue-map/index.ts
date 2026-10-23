import { peekGeoCatalog } from "../../../api-client/geo";
import { CHART_COMPOSER_PANE_ID } from "../../../types/config";
import type { PaneTemplateDef } from "../../../types/plugin";
import { chartHeadless } from "../chart-composer/headless";
import type { PluginModule } from "../plugin-module";
import { createChokepointInstance } from "./chokepoint-chart";
import { cloudGeoRequest } from "./client";
import { CHOKEPOINT_SERIES, createGeoChartSeriesCapability } from "./geo-series";
import { mapHeadless } from "./headless";
import { buildMapSettingsDef, groupTitle, MAP_PRESET_OPTIONS, parseMapPreset } from "./layers";
import { WORLD_VENUE_MAP_PANE_ID, WorldVenueMapPane } from "./pane";

const chartComposerHeadless = chartHeadless("chart-composer-pane");

const chokepointTemplate: PaneTemplateDef = {
  id: "chokepoint-chart-pane",
  paneId: CHART_COMPOSER_PANE_ID,
  headless: {
    ...chartComposerHeadless,
    description: "Daily vessel transits through the main shipping chokepoints, or one chokepoint by name.",
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
  shortcut: { prefix: "CHOKE", argPlaceholder: "chokepoint", argKind: "text", argOptional: true },
  canCreate: () => true,
  createInstance: (_context, options) => createChokepointInstance(cloudGeoRequest, options?.arg),
};

export const worldVenueMapModule: PluginModule = {
  panes: [
    {
      id: WORLD_VENUE_MAP_PANE_ID,
      name: "World Map",
      icon: "M",
      component: WorldVenueMapPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 124, height: 36 },
      // The layer picker comes from the server's catalog; without one the pane keeps its old settings.
      settings: (context) => buildMapSettingsDef(context.settings, peekGeoCatalog()?.layers) ?? { fields: [] },
    },
  ],
  paneTemplates: [
    {
      id: "world-venue-map-pane",
      paneId: WORLD_VENUE_MAP_PANE_ID,
      label: "World Map",
      description: "A world map with trading venues and their hours; ships, ports, energy and airports as layers.",
      keywords: ["world", "map", "globe", "countries", "venue", "venues", "exchange", "mic", "market hours", "open markets", "ships", "ship", "vessels", "vessel", "shipping", "ais", "ports", "port", "chokepoints", "pipelines", "airports", "energy", "layers"],
      shortcut: {
        prefix: "MAP",
        argPlaceholder: "layers",
        argKind: "text",
        argOptional: true,
        argOptions: () => MAP_PRESET_OPTIONS,
      },
      headless: mapHeadless,
      createInstance: (_context, options) => {
        const preset = parseMapPreset(options?.arg ?? options?.values?.layers);
        if (!preset) return { placement: "floating" };
        return {
          title: preset.layers.length ? `Map · ${preset.layers.map(groupTitle).join(", ")}` : "Map · Venues",
          placement: "floating",
          settings: { layers: preset.layers, venues: preset.venues },
        };
      },
    },
    chokepointTemplate,
  ],
  capabilities: [createGeoChartSeriesCapability()],
  series: CHOKEPOINT_SERIES,
};
