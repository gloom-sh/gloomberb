import { compareSortValues, type SortPreference } from "../../../utils/sort-values";

const TOP_PRODUCERS = 10;

const CROP_ORDER = ["Wheat", "Corn", "Soybeans", "Cotton"] as const;

const ATTRIBUTE_ORDER = ["Production", "Domestic use", "Exports", "Ending stocks"] as const;

const CROP_BY_CODE: Record<string, string> = {
  "0410000": "Wheat",
  "0440000": "Corn",
  "2222000": "Soybeans",
  "2631000": "Cotton",
};

const ATTRIBUTE_BY_DESCRIPTION: Record<string, (typeof ATTRIBUTE_ORDER)[number]> = {
  production: "Production",
  "domestic consumption": "Domestic use",
  "domestic use": "Domestic use",
  exports: "Exports",
  "ending stocks": "Ending stocks",
};

export interface BalanceRecord {
  crop: string;
  countryCode: string;
  country: string;
  marketYear: number;
  attribute: string;
  unit: string;
  value: number;
}

export interface BalanceRow {
  id: string;
  crop: string;
  country: string;
  attribute: string;
  value: number;
  unit: string;
  year: string;
  cropOrder: number;
  countryOrder: number;
  attributeOrder: number;
}

export interface PriceForecast {
  id: string;
  crop: string;
  forecast: number;
  unit: string;
  season: string;
  cropOrder: number;
  seasonYear: number;
}

export type BalanceColumnId = "crop" | "country" | "attribute" | "value" | "unit" | "year";
export type PriceColumnId = "crop" | "forecast" | "unit" | "season";

export const BALANCE_SORT: SortPreference<BalanceColumnId> = { columnId: null, direction: "asc" };
export const PRICE_SORT: SortPreference<PriceColumnId> = { columnId: null, direction: "asc" };

export function cropForCode(code: string): string | null {
  return CROP_BY_CODE[code.trim()] ?? null;
}

export function balanceAttribute(description: string): string | null {
  return ATTRIBUTE_BY_DESCRIPTION[description.trim().toLowerCase()] ?? null;
}

export function cleanUnit(unit: string): string {
  const trimmed = unit.trim();
  const wrapped = trimmed.match(/^\((.*)\)$/);
  return wrapped?.[1] ?? trimmed;
}

export function marketYearLabel(year: number): string {
  return `${year}/${String((year + 1) % 100).padStart(2, "0")}`;
}

export function formatBalanceValue(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const shown = Math.abs(rounded - Math.round(rounded)) < 0.001 ? Math.round(rounded) : rounded;
  const negative = shown < 0;
  const [whole, fraction] = Math.abs(shown).toString().split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function formatForecast(value: number): string {
  return value.toFixed(Math.abs(value) >= 1 ? 2 : 3);
}

export function priceUnit(unit: string): string {
  switch (unit.trim().toLowerCase()) {
    case "u.s. dollars per bushel":
      return "$/bu";
    case "u.s. dollars per pound":
      return "$/lb";
    default:
      return unit.trim();
  }
}

export function priceCrop(name: string): string | null {
  switch (name.trim().toLowerCase()) {
    case "wheat":
      return "Wheat";
    case "corn":
      return "Corn";
    case "soybeans":
    case "soybean":
      return "Soybeans";
    case "cotton":
    case "upland cotton":
      return "Cotton";
    default:
      return null;
  }
}

function isWorldCountry(country: string, code: string): boolean {
  const name = country.trim().toLowerCase();
  return name === "world" || name.startsWith("world ") || code.trim() === "00";
}

export function balanceBoard(records: readonly BalanceRecord[], limit = TOP_PRODUCERS): BalanceRow[] {
  const latest = new Map<string, number>();
  for (const record of records) {
    const year = latest.get(record.crop);
    if (year == null || record.marketYear > year) latest.set(record.crop, record.marketYear);
  }

  const byCrop = new Map<string, Map<string, {
    country: string;
    world: boolean;
    production: number;
    cells: Map<string, { value: number; unit: string }>;
  }>>();

  for (const record of records) {
    if (record.marketYear !== latest.get(record.crop)) continue;
    let countries = byCrop.get(record.crop);
    if (!countries) {
      countries = new Map();
      byCrop.set(record.crop, countries);
    }
    let bucket = countries.get(record.country);
    if (!bucket) {
      bucket = {
        country: record.country,
        world: isWorldCountry(record.country, record.countryCode),
        production: Number.NEGATIVE_INFINITY,
        cells: new Map(),
      };
      countries.set(record.country, bucket);
    }
    if (record.attribute === "Production") bucket.production = record.value;
    bucket.cells.set(record.attribute, { value: record.value, unit: record.unit });
  }

  const rows: BalanceRow[] = [];
  CROP_ORDER.forEach((crop, cropOrder) => {
    const countries = byCrop.get(crop);
    if (!countries) return;
    const buckets = [...countries.values()];
    const world = buckets.filter((bucket) => bucket.world);
    const ranked = buckets
      .filter((bucket) => !bucket.world && Number.isFinite(bucket.production))
      .sort((left, right) => right.production - left.production || left.country.localeCompare(right.country))
      .slice(0, Math.max(0, limit));
    const year = marketYearLabel(latest.get(crop)!);
    [...world, ...ranked].forEach((bucket, countryOrder) => {
      ATTRIBUTE_ORDER.forEach((attribute, attributeOrder) => {
        const cell = bucket.cells.get(attribute);
        if (!cell) return;
        rows.push({
          id: `${crop}|${bucket.country}|${attribute}`,
          crop,
          country: bucket.country,
          attribute,
          value: cell.value,
          unit: cell.unit,
          year,
          cropOrder,
          countryOrder,
          attributeOrder,
        });
      });
    });
  });
  return rows;
}

export function boardMarketYear(rows: readonly BalanceRow[]): string | null {
  const labels: string[] = [];
  for (const row of rows) {
    if (!labels.includes(row.year)) labels.push(row.year);
  }
  return labels.length === 0 ? null : labels.join(" ");
}

function balanceSortValue(row: BalanceRow, columnId: BalanceColumnId): string | number {
  switch (columnId) {
    case "crop":
      return row.crop;
    case "country":
      return row.country;
    case "attribute":
      return row.attribute;
    case "value":
      return row.value;
    case "unit":
      return row.unit;
    case "year":
      return row.year;
  }
}

function priceSortValue(row: PriceForecast, columnId: PriceColumnId): string | number {
  switch (columnId) {
    case "crop":
      return row.crop;
    case "forecast":
      return row.forecast;
    case "unit":
      return row.unit;
    case "season":
      return row.seasonYear;
  }
}

export function sortBalanceRows(
  rows: readonly BalanceRow[],
  sort: SortPreference<BalanceColumnId>,
): BalanceRow[] {
  const sorted = rows.slice();
  const columnId = sort.columnId;
  sorted.sort((left, right) => {
    const ranked = columnId == null
      ? 0
      : compareSortValues(balanceSortValue(left, columnId), balanceSortValue(right, columnId), sort.direction);
    return ranked || left.cropOrder - right.cropOrder || left.countryOrder - right.countryOrder || left.attributeOrder - right.attributeOrder;
  });
  return sorted;
}

export function sortPriceRows(
  rows: readonly PriceForecast[],
  sort: SortPreference<PriceColumnId>,
): PriceForecast[] {
  const sorted = rows.slice();
  const columnId = sort.columnId;
  sorted.sort((left, right) => {
    const ranked = columnId == null
      ? 0
      : compareSortValues(priceSortValue(left, columnId), priceSortValue(right, columnId), sort.direction);
    return ranked || left.cropOrder - right.cropOrder || left.seasonYear - right.seasonYear;
  });
  return sorted;
}
