/**
 * `gloomberb fn MAP`: the venue list, or with a layer (`MAP ships`,
 * `--layer vessels`) that layer's entity table with plain values and the
 * linked tickers, for JSON and CSV.
 */
import { getGeoEntities, loadGeoCatalog, type GeoLayerInfo, type GeoRequest } from "../../../api-client/geo";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneRow, HeadlessRowsResult } from "../../../types/headless";
import { columnValue, parseLayerTokens, plainGeoValue, resolveActiveLayers, tickerLinkKey } from "./layers";
import { filterWorldVenues, formatVenueLocalTime } from "./model";

function contextRequest(context: HeadlessPaneContext): GeoRequest {
  return <T>(path: string, init?: RequestInit) => context.apiClient.geo<T>(path, { ...init, signal: init?.signal ?? context.signal });
}

function tokensFor(args: { argument: unknown; options: Record<string, unknown> }, settings: Record<string, unknown> | undefined): string[] {
  const fromOption = parseLayerTokens(args.options.layer);
  if (fromOption.length) return fromOption;
  const fromSettings = parseLayerTokens(settings?.layers);
  if (fromSettings.length) return fromSettings;
  return parseLayerTokens(typeof args.argument === "string" ? args.argument : "");
}

const VENUE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "mic", header: "MIC" },
  { key: "name", header: "Venue" },
  { key: "city", header: "City" },
  { key: "country", header: "Country" },
  { key: "open", header: "Open", format: (value) => (value ? "open" : "closed") },
  { key: "localTime", header: "Local" },
];

async function venueRows(context: HeadlessPaneContext, query: string): Promise<HeadlessRowsResult> {
  const response = await context.apiClient.getCloudWorldVenues();
  if (!response.data) throw new Error(response.reasonCode ?? "World venue data unavailable");
  const now = Date.now();
  return {
    columns: VENUE_COLUMNS,
    rows: filterWorldVenues(response.data.venues, query).map((venue) => ({
      mic: venue.mic,
      name: venue.title,
      city: venue.city,
      country: venue.country,
      open: venue.isOpen,
      localTime: formatVenueLocalTime(venue.timezone, now),
      lon: venue.longitude,
      lat: venue.latitude,
    })),
    metadata: { layer: "venues", stale: response.stale === true },
  };
}

function layerColumns(layer: GeoLayerInfo): HeadlessPaneColumn[] {
  const columns = layer.columns.length ? layer.columns : [{ key: "label", label: "Name" }];
  return [
    ...columns.map((column): HeadlessPaneColumn => ({
      key: column.key,
      header: column.label,
      ...(column.align === "right" ? { align: "right" as const } : {}),
    })),
    { key: "ticker", header: "Ticker" },
    { key: "lon", header: "Lon", align: "right" },
    { key: "lat", header: "Lat", align: "right" },
  ];
}

export const mapHeadless = {
  shape: "rows",
  description: "Trading venues with open status and local time, or one map layer's entities (ships, chokepoints, ports, airports, pipelines, fields, terminals) with their fields and linked tickers.",
  argument: {
    kind: "free-text",
    placeholder: "layers",
    optional: true,
    description: "A layer group (ships, ports, energy, air) or a layer id; venues when empty.",
  },
  options: [
    { key: "layer", aliases: ["layers"], settingKey: "layers", description: "Layer id or group to list, such as vessels or energy.", type: "string" },
    { key: "query", aliases: ["q", "search"], description: "Filter by name or any field.", type: "string" },
    { key: "limit", description: "Rows to return.", type: "integer", defaultValue: 100, minimum: 1, maximum: 500 },
  ],
  discovery: {
    id: "world-map",
    aliases: ["world map", "venue map", "ship map", "vessel map", "chokepoints", "ports map", "pipelines map", "airports map"],
    screenshotReadiness: "ready",
  },
  describe: (args) => {
    const tokens = parseLayerTokens(args.options.layer || args.argument || "");
    return tokens.length ? `World Map | ${tokens.join(", ")}` : "World Map | venues";
  },
  async load(args, context) {
    const query = typeof args.options.query === "string" ? args.options.query : "";
    const tokens = tokensFor(args, context.settings);
    if (!tokens.length) return venueRows(context, query);
    const request = contextRequest(context);
    const catalog = await loadGeoCatalog(request, { signal: context.signal });
    const layers = resolveActiveLayers(tokens, catalog?.layers);
    const layer = layers[0];
    if (!layer) {
      const known = catalog?.layers.map((entry) => entry.id).join(", ");
      throw new Error(known ? `No map layer "${tokens.join(", ")}". Layers: ${known}.` : "Map layers are not available.");
    }
    const limit = typeof args.options.limit === "number" ? args.options.limit : 100;
    const page = layer.status === "unavailable"
      ? { rows: [], total: 0, asOf: null, columns: layer.columns }
      : await getGeoEntities(request, layer.id, { q: query, limit }, context.signal);
    const columns = page.columns?.length ? page.columns : layer.columns;
    const rows: HeadlessPaneRow[] = page.rows.map((row) => ({
      id: row.id,
      ...Object.fromEntries(columns.map((column) => [column.key, plainGeoValue(columnValue(row, column))])),
      ticker: row.tickers?.[0] ? tickerLinkKey(row.tickers[0]) : null,
      tickers: row.tickers?.length ? row.tickers.map(tickerLinkKey).join(", ") : null,
      lon: row.lon,
      lat: row.lat,
    }));
    return {
      columns: layerColumns({ ...layer, columns }),
      rows,
      complete: layer.status === "ok",
      errors: layer.status === "unavailable" ? [`${layer.name}: ${layer.statusNote ?? "unavailable"}`] : [],
      metadata: {
        layer: layer.id,
        name: layer.name,
        cadence: layer.cadence,
        status: layer.status,
        asOf: page.asOf ?? layer.asOf,
        total: page.total ?? null,
        ...(layers.length > 1 ? { otherLayers: layers.slice(1).map((entry) => entry.id) } : {}),
      },
    };
  },
} satisfies HeadlessPaneDefinition<"rows">;
