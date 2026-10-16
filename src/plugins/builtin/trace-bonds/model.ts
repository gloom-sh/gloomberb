import type { DataTableColumn } from "../../../components";
import { fitChartTableColumns } from "../../../components/chart-table";
import { colors } from "../../../theme/colors";
import { compareSortValues, type SortPreference } from "../../../utils/sort-values";
import type { CorporateBond } from "./client";

export const TRACE_BONDS_PANE_ID = "trace-bonds";

export type BondColumnId =
  | "issuer"
  | "cusip"
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
  "issuer", "cusip", "coupon", "maturity", "price", "yield", "change", "traded", "grade",
];

export function isBondColumnId(value: string): value is BondColumnId {
  return (BOND_COLUMN_IDS as readonly string[]).includes(value);
}

/** Newest sale first. A third header click returns here. */
export const DEFAULT_BOND_SORT: BondSort = { columnId: "traded", direction: "desc" };

export function firstBondSortDirection(columnId: BondColumnId): "asc" | "desc" {
  return columnId === "issuer" || columnId === "cusip" || columnId === "maturity" || columnId === "grade" ? "asc" : "desc";
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

function sortValue(columnId: BondColumnId, bond: CorporateBond): string | number | null {
  switch (columnId) {
    case "issuer":
      return bond.issuerName;
    case "cusip":
      return bond.cusip;
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
  { id: "cusip", label: "CUSIP", width: 10, align: "left" },
  { id: "coupon", label: "Coupon", width: 7, align: "right" },
  { id: "maturity", label: "Maturity", width: 11, align: "left" },
  { id: "price", label: "Price", width: 9, align: "right" },
  { id: "yield", label: "Yield", width: 8, align: "right" },
  { id: "change", label: "Chg", width: 8, align: "right" },
  { id: "traded", label: "Traded", width: 11, align: "left" },
  { id: "grade", label: "Grade", width: 6, align: "left" },
];

/**
 * What a narrow tape gives up first. The issuer, coupon and maturity name a
 * bond, so two of one issuer's issues stay told apart, and its price is
 * what was printed; they never go. The trade date, the default sort and
 * how old a last sale is, outlasts the CUSIP and yield. The headless report
 * moves its columns under the rows in the same order (`bondStackPriority`).
 */
const BOND_NARROW_DROP_ORDER: readonly BondColumnId[] = ["grade", "change", "cusip", "yield", "traded"];

/** `stackPriority` of each column in the text report: the higher, the sooner it moves under its row. */
export function bondStackPriority(columnId: BondColumnId): number {
  const index = BOND_NARROW_DROP_ORDER.indexOf(columnId);
  return index < 0 ? 0 : BOND_NARROW_DROP_ORDER.length - index;
}

export function buildBondColumns(width: number): BondColumn[] {
  return fitChartTableColumns(BOND_COLUMNS, width, BOND_NARROW_DROP_ORDER);
}
