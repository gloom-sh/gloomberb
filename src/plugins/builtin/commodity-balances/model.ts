import type { PsdBalanceRow, PsdPriceForecast } from "../../../api-client/commodity-balances";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";

/** One crop, country and attribute of the latest market year. */
export type BalanceRow = PsdBalanceRow;
/** A season-average farm price forecast. */
export type PriceForecast = PsdPriceForecast;

export type BalanceColumnId = "crop" | "country" | "attribute" | "value" | "unit" | "year";
export type PriceColumnId = "crop" | "forecast" | "unit" | "season";

export const BALANCE_SORT: SortPreference<BalanceColumnId> = { columnId: null, direction: "asc" };
export const PRICE_SORT: SortPreference<PriceColumnId> = { columnId: null, direction: "asc" };

/** The crops the board carries, in its order; the server names them so. */
export const PSD_CROPS = ["Wheat", "Corn", "Soybeans", "Cotton", "Coffee", "Sugar"] as const;
export type PsdCrop = typeof PSD_CROPS[number];

/** A typed crop as the board names it: "coffee", "Soybean" and "soy" read as Coffee and Soybeans. Null for anything else. */
export function psdCrop(input: string): PsdCrop | null {
  const typed = input.trim().toLowerCase().replace(/s$/, "");
  if (typed.length < 3) return null;
  return PSD_CROPS.find((crop) => crop.toLowerCase().replace(/s$/, "").startsWith(typed)) ?? null;
}

/** What the CLI answers a crop the board does not carry. */
export function unknownCropMessage(input: string): string {
  const names = PSD_CROPS.map((crop) => crop.toLowerCase());
  return `No crop "${input.trim()}". PSD covers ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`;
}

/** The month a crop's balances were estimated, from its rows; null when the board does not date them. */
export function cropEstimateMonth(rows: readonly BalanceRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => row.month && (!latest || row.month > latest) ? row.month : latest, null);
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
