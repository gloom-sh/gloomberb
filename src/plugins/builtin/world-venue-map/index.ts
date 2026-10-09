import { peekGeoCatalog } from "../../../api-client/geo";
import { SERIES_COLORS } from "../../../time-series/resolve";
import { CHART_COMPOSER_PANE_ID } from "../../../types/config";
import type { PaneTemplateDef } from "../../../types/plugin";
import { chartHeadless } from "../chart-composer/headless";
import { buildCustomChartPreset } from "../chart-composer/presets";
import { formatGeoSeriesExpression } from "../chart-composer/series-expression";
import type { PluginModule } from "../plugin-module";
import { cloudGeoRequest } from "./client";
import { chokepointSeriesFor, chokepointSeriesIds, createGeoChartSeriesCapability, KEY_CHOKEPOINTS } from "./geo-series";
import { mapHeadless } from "./headless";
import { buildMapSettingsDef, groupTitle, MAP_PRESET_OPTIONS, parseMapPreset } from "./layers";
import { WORLD_VENUE_MAP_PANE_ID, WorldVenueMapPane } from "./pane";

const CHOKE_SERIES_LIMIT = 6;

const chokepointTemplate: PaneTemplateDef = {
  id: "chokepoint-chart-pane",
  paneId: CHART_COMPOSER_PANE_ID,
  headless: { ...chartHeadless("chart-composer-pane"), description: "Daily vessel transits through the main shipping chokepoints, or one chokepoint by name." },
  label: "Chokepoint Transits",
  description: "Chart daily vessel transits through the main shipping chokepoints, or one of them.",
  keywords: ["chokepoint", "chokepoints", "transits", "suez", "panama", "hormuz", "malacca", "shipping", "strait", "canal"],
  shortcut: { prefix: "CHOKE", argPlaceholder: "chokepoint", argKind: "text", argOptional: true },
  canCreate: () => true,
  createInstance: async (_context, options) => {
    const typed = options?.arg?.trim();
    const named = typed ? await chokepointSeriesFor(cloudGeoRequest, typed) : null;
    const ids = named
      ? [named]
      // Without the series index, CHOKE still asks for the key straits by name.
      : await chokepointSeriesIds(cloudGeoRequest).then((found) => (found.length ? found : KEY_CHOKEPOINTS)).catch(() => KEY_CHOKEPOINTS);
    const base = buildCustomChartPreset(ids.slice(0, CHOKE_SERIES_LIMIT).map(formatGeoSeriesExpression).join(", "));
    // Daily transits read best over a year, each strait in its own colour.
    const spec = {
      ...base,
      viewport: { ...base.viewport, range: "1Y" as const },
      series: base.series.map((series, index) => ({ ...series, color: series.color ?? SERIES_COLORS[index % SERIES_COLORS.length]! })),
    };
    return {
      title: named ? `G ${named} transits` : "G Chokepoint transits",
      placement: "floating",
      settings: { chartSpec: spec },
    };
  },
};

export const worldVenueMapModule: PluginModule = {
  panes: [
    {
      id: WORLD_VENUE_MAP_PANE_ID,
      name: "World Venue Map",
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
      label: "World Venue Map",
      description: "Trading venues with live status and local time; ships, ports, energy and airports as layers on the same map.",
      keywords: ["world", "map", "venue", "venues", "exchange", "mic", "market hours", "open markets", "ships", "vessels", "ports", "chokepoints", "pipelines", "airports", "energy", "layers"],
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
          title: `Map · ${preset.layers.map(groupTitle).join(", ")}`,
          placement: "floating",
          settings: { layers: preset.layers, venues: preset.venues },
        };
      },
    },
    chokepointTemplate,
  ],
  capabilities: [createGeoChartSeriesCapability()],
};
