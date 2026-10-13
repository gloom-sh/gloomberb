import type { DataTableColumn } from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { colors } from "../../../theme/colors";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import type { CorporateBond } from "./client";

export const TRACE_BONDS_PANE_ID = "trace-bonds";

export type BondColumnId =
  | "issuer"
  | "coupon"
  | "maturity"
  | "price"
  | "yield"
  | "change"
  | "traded"
  | "grade";

export type BondColumn = DataTableColumn & { id: BondColumnId };
export type BondSort = SortPreference<BondColumnId>;

const BOND_COLUMN_IDS: readonly BondColumnId[] = [
  "issuer", "coupon", "maturity", "price", "yield", "change", "traded", "grade",
];

export function isBondColumnId(value: string): value is BondColumnId {
  return (BOND_COLUMN_IDS as readonly string[]).includes(value);
}

/** Newest sale first. A third header click returns here. */
export const DEFAULT_BOND_SORT: BondSort = { columnId: "traded", direction: "desc" };

export function firstBondSortDirection(columnId: BondColumnId): "asc" | "desc" {
  return columnId === "issuer" || columnId === "maturity" || columnId === "grade" ? "asc" : "desc";
}

export function formatBondDecimal(value: number | null, digits: number): string {
  if (value == null) return "—";
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

export function formatBondChange(value: number | null): string {
  if (value == null) return "—";
  const text = value.toFixed(3);
  if (Number(text) === 0) return "0.000";
  return value > 0 ? `+${text}` : text;
}

export function bondChangeColor(value: number | null): string {
  if (value == null || value === 0) return colors.textMuted;
  return value > 0 ? colors.positive : colors.negative;
}

export function filterBondsByIssuer(bonds: readonly CorporateBond[], query: string): CorporateBond[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...bonds];
  return bonds.filter((bond) => bond.issuerName.toLowerCase().includes(needle));
}

export function latestTradeDate(bonds: readonly CorporateBond[]): string | null {
  let latest: string | null = null;
  for (const bond of bonds) {
    if (bond.lastTradeDate && (latest == null || bond.lastTradeDate > latest)) latest = bond.lastTradeDate;
  }
  return latest;
}

function sortValue(columnId: BondColumnId, bond: CorporateBond): string | number | null {
  switch (columnId) {
    case "issuer":
      return bond.issuerName;
    case "coupon":
      return bond.couponRate;
    case "maturity":
      return bond.maturityDate;
    case "price":
      return bond.lastSalePrice;
    case "yield":
      return bond.lastSaleYield;
    case "change":
      return bond.priceChangeNumber;
    case "traded":
      return bond.lastTradeDate;
    case "grade":
      return bond.traceGradeCode;
  }
}

export function sortBonds(bonds: readonly CorporateBond[], sort: BondSort): CorporateBond[] {
  const columnId = sort.columnId ?? "traded";
  return [...bonds].sort((left, right) => {
    const compared = compareSortValues(sortValue(columnId, left), sortValue(columnId, right), sort.direction);
    if (compared !== 0) return compared;
    return compareSortValues(left.lastTradeDate, right.lastTradeDate, "desc");
  });
}

const BOND_COLUMNS: readonly BondColumn[] = [
  { id: "issuer", label: "Issuer", width: 18, align: "left", flexGrow: 1 },
  { id: "coupon", label: "Coupon", width: 8, align: "right" },
  { id: "maturity", label: "Maturity", width: 12, align: "left" },
  { id: "price", label: "Price", width: 10, align: "right" },
  { id: "yield", label: "Yield", width: 9, align: "right" },
  { id: "change", label: "Chg", width: 8, align: "right" },
  { id: "traded", label: "Traded", width: 12, align: "left" },
  { id: "grade", label: "Grade", width: 7, align: "left" },
];

/** Grade, then the change and yield, give way before the issuer, price, and trade date. */
const NARROW_DROP_ORDER: readonly BondColumnId[] = ["grade", "change", "yield", "coupon", "maturity"];

export function buildBondColumns(width: number): BondColumn[] {
  return fitChartTableColumns(BOND_COLUMNS, width, NARROW_DROP_ORDER);
}
