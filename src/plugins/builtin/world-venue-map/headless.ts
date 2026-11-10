/**
 * `gloom fn MAP`: the venue list, or with a layer (`MAP ships`,
 * `--layer vessels`) that layer's entity table with plain values and the
 * linked tickers, for JSON and CSV.
 */
import { getGeoEntities, loadGeoCatalog, type GeoColumn, type GeoEntitiesPayload, type GeoLayerInfo, type GeoRequest } from "../../../api-client/geo";
import type { HeadlessPaneColumn, HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneRow, HeadlessRowsResult } from "../../../types/headless";
import { formatUtcDayTime } from "../../../utils/utc-time";
import { REFERENCE_DATA } from "../shared/report-freshness";
import { columnValue, formatGeoValue, isChangeColumn, layerCoverageNote, parseLayerTokens, plainGeoValue, resolveActiveLayers, tickerLinkKey } from "./layers";
import { filterWorldVenues, formatVenueLocalTime } from "./model";
import { REPORT_FILTER, REPORT_ROWS } from "../shared/headless-options";

/**
 * A layer's status from its own cadence, as the pane's footer shows it. The
 * server says when a layer falls behind its source (`status`), so a daily
 * layer is not judged by age here: some sources publish a week late. A layer
 * that cannot serve has no data to describe; its error says why.
 */
function layerFreshness(layer: GeoLayerInfo): HeadlessPaneFreshness | undefined {
  if (layer.status === "unavailable") return undefined;
  // Cited as the server names who published it (the ports' and chokepoints' publisher), else Gloom Cloud.
  const cited = layer.publisher?.trim() ? { source: layer.publisher.trim(), publisher: layer.publisher.trim() } : {};
  if (layer.cadence === "live") return { status: "live", ...cited };
  if (layer.cadence === "daily") return { status: "not-a-feed", basis: "daily data", ...cited };
  return { ...REFERENCE_DATA, ...cited };
}

/** Map requests through the report's own client and signal. */
export function contextGeoRequest(context: HeadlessPaneContext): GeoRequest {
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
    freshness: REFERENCE_DATA,
    metadata: { layer: "venues", stale: response.stale === true },
  };
}

/** Formats whose figures the text report writes as the pane's table does: 1,234 calls, +12.5%. */
const FIGURE_FORMATS = new Set<GeoColumn["format"]>(["int", "decimal1", "percent1", "knots", "km"]);

/**
 * The layer's columns. A figure reads in the text report as the pane's table
 * writes it, a change signed and with its %; exports keep the bare number,
 * so a percent column names its unit in its header.
 */
function layerColumns(layer: GeoLayerInfo): HeadlessPaneColumn[] {
  const columns: GeoColumn[] = layer.columns.length ? layer.columns : [{ key: "label", label: "Name" }];
  return [
    ...columns.map((column): HeadlessPaneColumn => ({
      key: column.key,
      header: column.format === "percent1" && !column.label.includes("%") ? `${column.label} (%)` : column.label,
      ...(column.format === "percent1" ? { textHeader: column.label } : {}),
      ...(column.align === "right" ? { align: "right" as const } : {}),
      ...(FIGURE_FORMATS.has(column.format) ? {
        textFormat: (value: unknown) => (typeof value === "number" ? formatGeoValue(value, column.format, Date.now(), isChangeColumn(column)) : "-"),
      } : {}),
    })),
    { key: "ticker", header: "Ticker" },
    { key: "lon", header: "Lon", align: "right" },
    { key: "lat", header: "Lat", align: "right" },
  ];
}

/** Whether the layer's figures are sums over the 7 days to its date (the ports' calls and tonnes). */
function weeklyLayer(columns: readonly GeoColumn[]): boolean {
  return columns.some((column) => /\b7D\b/.test(column.label));
}

/**
 * The text report's last row: the server's totals over every row the query
 * found, not only the rows listed, named for the country a country's name
 * was read as. Exports keep the entities alone; JSON has the totals in its metadata.
 */
function totalRow(page: Pick<GeoEntitiesPayload, "totals" | "total" | "matched">, columns: readonly GeoColumn[], rows: readonly HeadlessPaneRow[], noun: string): HeadlessPaneRow | null {
  if (!page.totals || page.total <= 1) return null;
  const [first] = columns;
  const country = page.matched === "country" && typeof rows[0]?.country === "string" ? rows[0].country : null;
  return {
    id: "total",
    ...Object.fromEntries(columns.map((column) => [column.key, plainGeoValue(page.totals?.[column.key])])),
    [first?.key ?? "label"]: `Total, ${page.total} ${noun}`,
    ...(country ? { country } : {}),
    ticker: null,
    lon: null,
    lat: null,
  };
}

/**
 * What a search that finds nothing says. A search outside a one-country layer
 * finds nothing because the layer has nothing there; ships are found by name,
 * or by the name or ticker of an operator whose fleet is linked, so anything
 * else (or a server that links no fleet) gets a name to try.
 */
function emptySearchNote(layer: GeoLayerInfo, query: string): string | null {
  const typed = query.trim();
  if (!typed) return null;
  const coverage = layerCoverageNote(layer);
  if (coverage) return `No ${layer.name.toLowerCase()} match "${typed}". ${coverage}`;
  if (layer.id === "vessels") return `No ${layer.name.toLowerCase()} match "${typed}"; try a ship-name prefix or an operator, such as --query Norwegian or --query "Royal Caribbean".`;
  return null;
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
    { key: "query", shot: REPORT_FILTER, aliases: ["q", "search"], description: "Filter by name or any field.", type: "string" },
    { key: "limit", shot: REPORT_ROWS, description: "Rows to return.", type: "integer", defaultValue: 100, minimum: 1, maximum: 500 },
  ],
  discovery: {
    id: "world-map",
    aliases: ["world map", "venue map", "ship map", "vessel map", "chokepoints", "ports map", "pipelines map", "airports map"],
    screenshotReadiness: "ready",
  },
  describe: (args, result) => {
    const tokens = parseLayerTokens(args.options.layer || args.argument || "");
    if (!tokens.length) return "World Map | venues";
    // A layer of 7-day sums names the week they end on, which its source line dates without saying so.
    const weekEnding = typeof result?.metadata?.weekEnding === "string" ? ` | week ending ${formatUtcDayTime({ time: Date.parse(result.metadata.weekEnding), dateOnly: true })}` : "";
    return `World Map | ${tokens.join(", ")}${weekEnding}`;
  },
  async load(args, context) {
    const query = typeof args.options.query === "string" ? args.options.query : "";
    const tokens = tokensFor(args, context.settings);
    if (!tokens.length) return venueRows(context, query);
    const request = contextGeoRequest(context);
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
    const empty = emptySearchNote(layer, query);
    const total = "totals" in page ? totalRow(page, columns, rows, layer.name.toLowerCase()) : null;
    const asOf = page.asOf ?? layer.asOf;
    const weekEnding = asOf && rows.length && weeklyLayer(columns) ? asOf.slice(0, 10) : null;
    return {
      columns: layerColumns({ ...layer, columns }),
      rows,
      ...(total ? { textRows: [...rows, total] } : {}),
      ...(empty ? { empty } : {}),
      freshness: layerFreshness(layer),
      complete: layer.status === "ok",
      errors: layer.status === "unavailable" ? [`${layer.name}: ${layer.statusNote ?? "unavailable"}`] : [],
      metadata: {
        layer: layer.id,
        name: layer.name,
        cadence: layer.cadence,
        status: layer.status,
        asOf,
        total: page.total ?? null,
        ...("totals" in page && page.totals ? { totals: page.totals } : {}),
        ...("matched" in page && page.matched ? { matched: page.matched } : {}),
        ...(weekEnding ? { weekEnding } : {}),
        ...(layers.length > 1 ? { otherLayers: layers.slice(1).map((entry) => entry.id) } : {}),
      },
    };
  },
} satisfies HeadlessPaneDefinition<"rows">;
