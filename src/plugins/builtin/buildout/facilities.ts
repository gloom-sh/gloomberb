/**
 * TheBuildout's facilities as a layer of the world map: data centers, fabs,
 * power plants, mines and the plants around them, read from the dataset's own
 * map of located sites. A map linked to TheBuildout (or to any list) shows the
 * selected company's sites, owned or not, or every site owned by a company in
 * the selected theme. The dataset answers with what this account may see, so
 * a theme's sites follow the same free and Pro split as the theme's companies.
 */
import type {
  GeoBbox,
  GeoColumn,
  GeoEntitiesPayload,
  GeoEntityPayload,
  GeoEntityRow,
  GeoFeature,
  GeoFeaturesPayload,
  GeoLayerInfo,
  GeoPropValue,
} from "../../../api-client/geo";
import type { LocalEntityQuery, LocalFeatureQuery, LocalGeoLayer } from "../world-venue-map/local-layers";
import { createTtlCache } from "../../../data/ttl-cache";
import { type BuildoutReader, buildoutApi, getBuildoutReader } from "./model";

const FACILITIES_LAYER_ID = "facilities";

interface WorldMapPoint {
  id: string;
  name: string;
  type: string | null;
  siteRoles?: string[] | null;
  physicalForms?: string[] | null;
  capabilities?: string[] | null;
  countryIso?: string | null;
  ownerCompanyId?: string | null;
  ownerTicker?: string | null;
  ownerName?: string | null;
  powerCapacity?: string | null;
  constructionActivity?: number | null;
  relevance?: { category?: string | null; score?: number | null; tier?: string | null; reasons?: string[] | null } | null;
  lat: number;
  lng: number;
  coordinateSource?: string | null;
}

interface WorldMapPayload {
  generatedAt?: string | null;
  points?: WorldMapPoint[];
  scope?: { kind?: string; id?: string | null; ticker?: string | null } | null;
}

interface FacilitySet {
  asOf: string | null;
  rows: GeoEntityRow[];
  byId: Map<string, { row: GeoEntityRow; point: WorldMapPoint }>;
}

const COLUMNS: GeoColumn[] = [
  { key: "label", label: "Facility" },
  { key: "type", label: "Type" },
  { key: "mw", label: "MW", align: "right", format: "int" },
  { key: "owner", label: "Owner" },
  { key: "country", label: "Country" },
];

const INFO: GeoLayerInfo = {
  id: FACILITIES_LAYER_ID,
  name: "Facilities",
  group: "infrastructure",
  geometry: "point",
  cadence: "daily",
  refreshSeconds: null,
  asOf: null,
  count: null,
  status: "ok",
  access: "free",
  columns: COLUMNS,
  series: [],
  defaultVisible: false,
};

/** Sites with no use to a map of the build-out: head offices and rows the dataset has not typed. */
const LEFT_OUT = new Set(["office", ""]);
const ALL_TTL_MS = 30 * 60_000;
const SCOPED_TTL_MS = 10 * 60_000;
const THEME_PAGE = 200;

const TYPE_WORDS: Record<string, string> = {
  "Manufacturing Plant": "Plant",
  "Semiconductor Fab": "Fab",
  "Power Station": "Power plant",
  "Advanced Packaging": "Packaging",
  "Energy Storage Facility": "Storage",
  "R&D Center": "R&D",
  "Logistics Hub": "Logistics",
  "Transmission Line": "Transmission",
  "Utility Network": "Utility",
};

function entityKind(type: string | null): string {
  switch (type) {
    case "Data Center": return "data-center";
    case "Power Station":
    case "Substation":
    case "Energy Storage Facility": return "power-plant";
    case "Semiconductor Fab":
    case "Advanced Packaging": return "fab";
    default: return "facility";
  }
}

/** "300.00 MW" reads 300; a site the dataset has no figure for has none. */
function megawatts(value: string | null | undefined): number | null {
  const match = value?.replace(/,/g, "").match(/([\d.]+)\s*(GW|MW|KW)/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  const unit = match[2]!.toUpperCase();
  const mw = unit === "GW" ? number * 1000 : unit === "KW" ? number / 1000 : number;
  return mw >= 10 ? Math.round(mw) : Math.round(mw * 10) / 10;
}

const PLACED_BY: Record<string, string> = { geocode: "Address", metadata: "Site record", boundary: "Traced boundary" };

function toRow(point: WorldMapPoint): GeoEntityRow {
  const ticker = point.ownerTicker?.trim();
  return {
    id: point.id,
    label: point.name,
    lon: point.lng,
    lat: point.lat,
    props: {
      type: point.type ? TYPE_WORDS[point.type] ?? point.type : null,
      mw: megawatts(point.powerCapacity),
      owner: point.ownerName ?? null,
      country: point.countryIso ?? null,
    },
    ...(ticker ? { tickers: [{ symbol: ticker, via: "owner" as const, confidence: "reviewed" as const }] } : {}),
  };
}

/** The score the dataset gives a site for the build-out, plus a little for its size, so a capped answer keeps what matters. */
function rank(point: WorldMapPoint): number {
  const mw = megawatts(point.powerCapacity) ?? 0;
  return (point.relevance?.score ?? 0) + Math.min(20, Math.log10(1 + mw) * 6);
}

function facilitySet(payload: WorldMapPayload, keep: (point: WorldMapPoint) => boolean = () => true): FacilitySet {
  const points = (payload.points ?? []).filter((point) => (
    Number.isFinite(point.lat) && Number.isFinite(point.lng) && !LEFT_OUT.has((point.type ?? "").toLowerCase()) && keep(point)
  )).sort((left, right) => rank(right) - rank(left));
  const byId = new Map<string, { row: GeoEntityRow; point: WorldMapPoint }>();
  const rows = points.map((point) => {
    const row = toRow(point);
    byId.set(row.id, { row, point });
    return row;
  });
  return { asOf: payload.generatedAt ?? null, rows, byId };
}

// Every entry is one reader's: the free set is the same for everyone signed
// out or without Buildout, and a token's answer belongs to its account. A
// sign-out, a plan that ends or one that starts reads under a new key.
const allSites = createTtlCache<FacilitySet>({ ttlMs: ALL_TTL_MS, maxEntries: 4 });
const scopedSites = createTtlCache<FacilitySet>({ ttlMs: SCOPED_TTL_MS, maxEntries: 64 });
const themeCompanies = createTtlCache<Set<string>>({ ttlMs: ALL_TTL_MS, maxEntries: 64 });

function readerKey(reader: BuildoutReader): string {
  return reader.token ? `pro:${reader.account}` : "free";
}

function loadAll(reader: BuildoutReader): Promise<FacilitySet> {
  return allSites.load(readerKey(reader), async () => facilitySet(await buildoutApi<WorldMapPayload>("/sites/world-map", reader.token)));
}

/** The company's own sites and the ones it is named at. An unknown ticker has none. */
function loadCompany(reader: BuildoutReader, symbol: string): Promise<FacilitySet> {
  return scopedSites.load(`${readerKey(reader)}|company:${symbol}`, async () => {
    try {
      return facilitySet(await buildoutApi<WorldMapPayload>(`/sites/world-map?company=${encodeURIComponent(symbol)}`, reader.token));
    } catch (error) {
      if (error instanceof Error && /not found|404/i.test(error.message)) return { asOf: null, rows: [], byId: new Map() };
      throw error;
    }
  });
}

/** The ids of the theme's companies this account can see. */
function loadThemeCompanies(reader: BuildoutReader, slug: string): Promise<Set<string>> {
  return themeCompanies.load(`${readerKey(reader)}|${slug}`, async () => {
    const ids = new Set<string>();
    for (let offset = 0; offset < 2000; offset += THEME_PAGE) {
      const page = await buildoutApi<{ companies?: Array<{ id?: string }> } | Array<{ id?: string }>>(
        `/companies?list=${encodeURIComponent(slug)}&limit=${THEME_PAGE}&offset=${offset}&sort=marketCap&order=desc`,
        reader.token,
      );
      const companies = Array.isArray(page) ? page : page.companies ?? [];
      for (const company of companies) if (company.id) ids.add(company.id);
      if (companies.length < THEME_PAGE) break;
    }
    return ids;
  });
}

async function loadScope(scope: string | null): Promise<FacilitySet> {
  const reader = await getBuildoutReader();
  if (scope?.startsWith("company:")) return loadCompany(reader, scope.slice("company:".length));
  if (scope?.startsWith("theme:")) {
    const slug = scope.slice("theme:".length);
    return scopedSites.load(`${readerKey(reader)}|${scope}`, async () => {
      const [all, ids] = await Promise.all([loadAll(reader), loadThemeCompanies(reader, slug)]);
      return {
        asOf: all.asOf,
        rows: all.rows.filter((row) => ids.has(all.byId.get(row.id)?.point.ownerCompanyId ?? "")),
        byId: all.byId,
      };
    });
  }
  return loadAll(reader);
}

function inBbox(row: GeoEntityRow, bbox: GeoBbox | null): boolean {
  if (!bbox) return true;
  const [west, south, east, north] = bbox;
  if (row.lat < south || row.lat > north) return false;
  return west <= east ? row.lon >= west && row.lon <= east : row.lon >= west || row.lon <= east;
}

function feature(row: GeoEntityRow, point: WorldMapPoint): GeoFeature {
  return {
    id: row.id,
    layer: FACILITIES_LAYER_ID,
    entityKind: entityKind(point.type),
    label: row.label,
    geometry: { type: "Point", coordinates: [row.lon, row.lat] },
    ts: null,
    props: row.props,
    ...(row.tickers ? { tickers: row.tickers } : {}),
  };
}

function matches(row: GeoEntityRow, needle: string): boolean {
  if (!needle) return true;
  const symbol = needle.replace(/^\$/, "").toUpperCase();
  if (row.tickers?.some((link) => link.symbol.toUpperCase() === symbol)) return true;
  return [row.label, ...Object.values(row.props)].some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}

function compare(key: string | null, dir: "asc" | "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return (left: GeoEntityRow, right: GeoEntityRow) => {
    if (!key) return 0;
    const a: GeoPropValue = key === "label" ? left.label : left.props[key] ?? null;
    const b: GeoPropValue = key === "label" ? right.label : right.props[key] ?? null;
    // Missing values sink in either direction.
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
    return String(a).localeCompare(String(b)) * sign;
  };
}

const PLAIN_LIST = (values: string[] | null | undefined, count = 6) => (values?.length ? values.slice(0, count).join(", ") : null);

export const facilitiesLayer: LocalGeoLayer = {
  info: INFO,
  async features(query: LocalFeatureQuery): Promise<GeoFeaturesPayload> {
    const set = await loadScope(query.scope);
    const inView = set.rows.filter((row) => inBbox(row, query.bbox));
    const kept = inView.slice(0, query.limit);
    return {
      layer: FACILITIES_LAYER_ID,
      asOf: set.asOf,
      features: kept.map((row) => feature(row, set.byId.get(row.id)!.point)),
      total: inView.length,
      truncated: kept.length < inView.length,
    };
  },
  async entities(query: LocalEntityQuery): Promise<GeoEntitiesPayload> {
    const set = await loadScope(query.scope);
    const needle = query.q.trim().toLowerCase();
    const rows = set.rows.filter((row) => inBbox(row, query.bbox) && matches(row, needle));
    const sorted = query.sort ? [...rows].sort(compare(query.sort, query.dir)) : rows;
    return {
      layer: FACILITIES_LAYER_ID,
      asOf: set.asOf,
      columns: COLUMNS,
      rows: sorted.slice(query.offset, query.offset + query.limit),
      total: rows.length,
    };
  },
  async entity(id: string, scope: string | null): Promise<GeoEntityPayload> {
    const set = await loadScope(scope);
    const found = set.byId.get(id) ?? (await loadAll(await getBuildoutReader())).byId.get(id);
    if (!found) throw new Error("Unknown facility");
    const { row, point } = found;
    const relevance = point.relevance?.tier
      ? `${point.relevance.tier.charAt(0).toUpperCase()}${point.relevance.tier.slice(1)}${point.relevance.reasons?.length ? `: ${point.relevance.reasons.join(", ")}` : ""}`
      : null;
    return {
      feature: feature(row, point),
      detail: {
        roles: PLAIN_LIST(point.siteRoles),
        forms: PLAIN_LIST(point.physicalForms),
        capabilities: PLAIN_LIST(point.capabilities),
        relevance,
        placedBy: point.coordinateSource ? PLACED_BY[point.coordinateSource] ?? null : null,
      },
    };
  },
};
