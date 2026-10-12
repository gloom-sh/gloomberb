import type { GasStorageHistory, GasStorageRow, GasStorageSeasonal } from "../../../api-client/europe-energy";
import { staticSeries } from "../../../components/chart/static/series";
import type { SeriesDefinition, SeriesLoadResult } from "../../../series/types";
import type { ResolvedSeries } from "../../../time-series/types";
import { fetchGasHistory } from "./gas-client";

/**
 * The areas the server serves gas storage for, known before the board loads
 * so the data catalog can list them: the EU aggregate as GIE AGSI+ publishes
 * it, then each member state with storage.
 */
export const GAS_STORAGE_AREAS = [
  { code: "EU", name: "EU" }, { code: "AT", name: "Austria" }, { code: "BE", name: "Belgium" }, { code: "BG", name: "Bulgaria" },
  { code: "HR", name: "Croatia" }, { code: "CZ", name: "Czechia" }, { code: "DK", name: "Denmark" }, { code: "FR", name: "France" },
  { code: "DE", name: "Germany" }, { code: "HU", name: "Hungary" }, { code: "IT", name: "Italy" }, { code: "LV", name: "Latvia" },
  { code: "NL", name: "Netherlands" }, { code: "PL", name: "Poland" }, { code: "PT", name: "Portugal" }, { code: "RO", name: "Romania" },
  { code: "SK", name: "Slovakia" }, { code: "ES", name: "Spain" }, { code: "SE", name: "Sweden" },
] as const;

export type GasStorageArea = (typeof GAS_STORAGE_AREAS)[number];

const ALIASES: Readonly<Record<string, string>> = {
  "EUROPEAN UNION": "EU", EU27: "EU", "EU 27": "EU", "CZECH REPUBLIC": "CZ", HOLLAND: "NL",
  DEU: "DE", FRA: "FR", NLD: "NL", BEL: "BE", ESP: "ES", ITA: "IT", AUT: "AT", POL: "PL", CZE: "CZ",
};

/** A typed area: its code (DE), name (germany), EU or a common alias. */
export function gasStorageArea(input: string | null | undefined): GasStorageArea | null {
  const key = input?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
  if (!key) return null;
  const code = ALIASES[key] ?? key;
  return GAS_STORAGE_AREAS.find((area) => area.code === code || area.name.toUpperCase() === key) ?? null;
}

/** What `EPWR GAS` asks for: the gas board, and the area after it (EU by default). */
const GAS_PREFIX = /^(?:GAS(?:[\s-]+STORAGE)?|STORAGE)(?:\s+(.*))?$/i;

/**
 * `GAS`, `GAS DE`, `gas storage germany`: the gas board and the area it opens
 * on. Null for anything else, so `EPWR DE` stays a power market; throws for a
 * gas query naming an area the board does not list.
 */
export function parseGasQuery(input: string | null | undefined): { area: GasStorageArea; named: boolean } | null {
  const match = GAS_PREFIX.exec(input?.trim() ?? "");
  if (!match) return null;
  const rest = match[1]?.trim();
  const area = rest ? gasStorageArea(rest) : GAS_STORAGE_AREAS[0];
  if (!area) throw new Error(`No gas storage for "${rest}". Use EU or a country such as DE, IT or Netherlands.`);
  return { area, named: !!rest };
}

const GAS_PAGE_URL = "https://agsi.gie.eu/";
export const GAS_PUBLISHER = "GIE AGSI+";

const fixed = (value: number, digits: number) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (value: number, digits: number) => `${value > 0 ? "+" : ""}${fixed(value, digits)}`;
/** Percent full, to the hundredth AGSI+ publishes. */
export const formatGasFull = (value: number | null | undefined) => value == null ? "--" : fixed(value, 2);
/** Percentage points. */
export const formatGasPoints = (value: number | null | undefined) => value == null ? "--" : signed(value, 2);
/** TWh to the tenth. */
export const formatGasTwh = (value: number | null | undefined) => value == null ? "--" : fixed(value, 1);
/** GWh/day, whole. */
export const formatGasFlow = (value: number | null | undefined) => value == null ? "--" : fixed(value, 0);

/** Where the day sits in its five-year range: a percentile-like 0 to 100, or below and above it. */
export function gasRangePosition(row: GasStorageRow): { value: number | null; text: string } {
  const position = row.fiveYear?.position;
  if (position == null) return { value: null, text: "--" };
  if (position < 0) return { value: 0, text: "below" };
  if (position > 100) return { value: 100, text: "above" };
  return { value: Math.round(position), text: `${Math.round(position)}%` };
}

/** The range's name: 5Y, or the years it holds where history is short. */
export const gasRangeLabel = (years: number) => `${years > 0 && years < 5 ? years : 5}Y`;

/** A gas day and its flag, the way a row is dated: `2026-10-12 est`. */
export const gasDayText = (row: Pick<GasStorageRow, "gasDay" | "status">) =>
  row.gasDay ? `${row.gasDay}${row.status === "estimated" ? " est" : ""}` : "--";

/** The benchmark areas a search lists first; the rest follow by name. */
const LEAD_AREAS = ["EU", "DE", "IT", "FR", "NL", "AT"];
const leadRank = (code: string) => (LEAD_AREAS.indexOf(code) + LEAD_AREAS.length + 1) % (LEAD_AREAS.length + 1);
const ATTRIBUTION = { source: GAS_PUBLISHER, publisher: "Gas Infrastructure Europe" } as const;

type GasPoint = GasStorageHistory["points"][number];
const MEASURES: ReadonlyArray<{
  id: string; unit: string; label: (name: string) => string; description: (name: string) => string; tags: readonly string[];
  value: (point: GasPoint) => number | null;
}> = [
  { id: "gas-storage", unit: "%", label: (name) => `${name} gas storage, % full`,
    description: (name) => `${name} gas in storage at the end of each gas day, as a percentage of working gas volume.`,
    tags: ["gas storage", "storage", "fullness", "filling level", "natural gas", "gas", "Europe"], value: (point) => point.full },
  { id: "gas-storage-twh", unit: "TWh", label: (name) => `${name} gas in storage`,
    description: (name) => `${name} gas in storage at the end of each gas day, in TWh.`,
    tags: ["gas storage", "storage", "inventory", "natural gas", "gas", "Europe"], value: (point) => point.gasInStorage },
  { id: "gas-injection", unit: "GWh/day", label: (name) => `${name} gas storage net injection`,
    description: (name) => `${name} gas injected into storage less gas withdrawn each gas day, in GWh/day; negative is a net withdrawal.`,
    tags: ["gas storage", "injection", "withdrawal", "natural gas", "gas", "Europe"],
    value: (point) => point.injection == null || point.withdrawal == null ? null : Number((point.injection - point.withdrawal).toFixed(2)) },
];

/**
 * Each area's daily storage as `CAP:gas-storage:eu` (% full),
 * `CAP:gas-storage-twh:eu` (TWh) and `CAP:gas-injection:eu` (net injection,
 * GWh/day). A day without the figure is left out, never drawn as zero.
 */
export const GAS_STORAGE_SERIES: readonly SeriesDefinition[] = MEASURES.flatMap((measure) =>
  [...GAS_STORAGE_AREAS].sort((left, right) => leadRank(left.code) - leadRank(right.code)).map((area): SeriesDefinition => ({
    id: `${measure.id}:${area.code.toLowerCase()}`,
    name: measure.label(area.name),
    unit: measure.unit,
    frequency: "daily",
    group: "Energy",
    tags: [...measure.tags, area.code, ...(area.code === "EU" ? ["European Union"] : [])],
    description: measure.description(area.name),
    publisher: GAS_PUBLISHER,
    url: GAS_PAGE_URL,
    load: async ({ start }): Promise<SeriesLoadResult> => {
      const history = await fetchGasHistory(area.code, start?.toISOString().slice(0, 10));
      return {
        points: history.points.flatMap((point) => {
          const value = measure.value(point);
          return value == null ? [] : [{ date: point.date, value }];
        }),
        attribution: ATTRIBUTION,
      };
    },
  })));

export interface GasChartColors {
  bg: string;
  positive: string;
  warning: string;
  textDim: string;
}

const day = (date: string) => new Date(`${date}T00:00:00Z`);
const line = (id: string, label: string, color: string, points: ReadonlyArray<[string, number]>): ResolvedSeries => ({
  ...staticSeries(points.map(([date, value]) => ({ date: day(date), observedAt: day(date), value })), { id, label, color, calendarSpaced: true }),
  unit: "%", unitGroup: "gas-full",
});

/**
 * The area's year, last year's line and the five-year average inside the
 * shaded five-year range, every point on this year's calendar. A range that
 * holds fewer years says so in its label; a day no band year reaches has none.
 */
export function gasSeasonalSeries(seasonal: GasStorageSeasonal, colors: GasChartColors, blend: (from: string, to: string, amount: number) => string): ResolvedSeries[] {
  if (seasonal.year == null) return [];
  const band: ResolvedSeries = {
    ...staticSeries(seasonal.band.flatMap(([date, min, average, max]) => min == null || average == null || max == null ? []
      : [{ date: day(date), observedAt: day(date), value: average, low: min, high: max }]),
    { id: "five-year", label: `${gasRangeLabel(seasonal.years.length)} avg`, color: colors.warning, style: "band", calendarSpaced: true }),
    unit: "%", unitGroup: "gas-full",
  };
  // The area's year leads, so the legend names it and the cursor reads its level.
  return [
    line("current", `${seasonal.name} ${seasonal.year}`, colors.positive, seasonal.current),
    line("previous", String(seasonal.year - 1), blend(colors.bg, colors.textDim, 0.8), seasonal.previous),
    band,
  ].filter((series) => series.points.length > 0);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/**
 * The seasonal chart's axis: one calendar year, labelled at the quarters, the
 * cursor read as a day ("Oct 12"). An axis of its own also makes the legend
 * read the cursor's day across the lines, not each line's last point.
 */
export function gasYearAxis(year: number) {
  const start = Date.UTC(year, 0, 1);
  const span = Date.UTC(year, 11, 31) - start;
  const ratio = (time: number) => (time - start) / span;
  return {
    viewport: { start: new Date(start), end: new Date(start + span) },
    xAxis: {
      ticks: [0, 3, 6, 9].map((month) => ({ label: MONTHS[month]!, ratio: ratio(Date.UTC(year, month, 1)) })),
      formatCursor: (xRatio: number) => {
        const date = new Date(start + Math.round((xRatio * span) / DAY_MS) * DAY_MS);
        return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
      },
    },
  };
}

/** The area's whole kept history of fullness, for its detail. */
export function gasHistorySeries(history: GasStorageHistory, color: string): ResolvedSeries[] {
  return [line(`gas-storage:${history.code}`, `${history.name} % full`, color,
    history.points.flatMap((point): Array<[string, number]> => point.full == null ? [] : [[point.date, point.full]]))];
}
