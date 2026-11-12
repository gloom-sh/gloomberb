import { summaryRowKey, type TickerTableSummaryRow } from "../../../components/ticker/list-table-view";
import {
  CASH_SYMBOL,
  formatAllocationDrift,
  formatAllocationWeight,
  type PortfolioAllocation,
} from "../../../portfolio/allocation";
import { priceColor } from "../../../theme/colors";
import { formatCompactAmount } from "../../../utils/format";

/** The cash line's row, which the cursor lands on so it takes a target like a holding. */
export const CASH_ROW_KEY = summaryRowKey("cash");

type SummaryCell = TickerTableSummaryRow["cells"][string];

/** A signed figure as the rows color one: green or red, none once it rounds to zero. */
function signed(text: string, value: number | null | undefined): SummaryCell {
  return value != null && Number.isFinite(value) && /[1-9]/.test(text) ? { text, color: priceColor(value), value } : { text, value: value ?? null };
}

/** Adds up the figures that are known; null when none is. */
function sumKnown(values: readonly (number | null | undefined)[]): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value != null && Number.isFinite(value)) sum = (sum ?? 0) + value;
  }
  return sum;
}

/**
 * The CASH and TOTAL rows under a book's holdings, as `portfolio show`
 * prints them. CASH has its value, weight, target, drift and, in TRADE VAL,
 * the amount that reaches its target: TRADE counts units, which cash has
 * none of, so it stays blank there. TOTAL adds up the allocation columns:
 * the weight, the targets, the drifts and the trades, so a book whose targets
 * cover it sums to zero. Its value, day and P&L are the header's, and stay
 * there. Null rows when the book has neither cash nor a target.
 */
export function allocationSummaryRows(
  allocation: Pick<PortfolioAllocation, "rows" | "cash" | "total" | "weightBasis" | "targetSum">,
  { cashCurrency, currency }: { cashCurrency?: string | null; currency: string },
): TickerTableSummaryRow[] {
  const rows: TickerTableSummaryRow[] = [];
  const { cash } = allocation;
  if (cash) {
    rows.push({
      id: "cash",
      selectable: true,
      cells: {
        ticker: { text: cashCurrency && cashCurrency !== currency ? `${CASH_SYMBOL} ${cashCurrency}` : CASH_SYMBOL },
        mkt_value: { text: formatCompactAmount(cash.value), value: cash.value },
        weight: { text: formatAllocationWeight(cash.weight), value: cash.weight },
        target_weight: { text: formatAllocationWeight(cash.targetWeight), value: cash.targetWeight },
        drift: signed(formatAllocationDrift(cash.drift), cash.drift),
        trade_value: signed(formatCompactAmount(cash.tradeValue ?? undefined, { signed: true }), cash.tradeValue),
      },
    });
  }
  const weight = allocation.weightBasis === "total" && allocation.total != null && allocation.total > 0 ? 100 : null;
  const lines = [...allocation.rows, ...(cash ? [cash] : [])];
  const drift = sumKnown(lines.map((line) => line.drift));
  const tradeValue = sumKnown(lines.map((line) => line.tradeValue));
  rows.push({
    id: "total",
    cells: {
      ticker: { text: "TOTAL" },
      weight: { text: formatAllocationWeight(weight), value: weight },
      target_weight: { text: formatAllocationWeight(allocation.targetSum), value: allocation.targetSum },
      drift: signed(formatAllocationDrift(drift), drift),
      trade_value: signed(formatCompactAmount(tradeValue ?? undefined, { signed: true }), tradeValue),
    },
  });
  return rows;
}
