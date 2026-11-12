import { summaryRowKey, type TickerTableSummaryRow } from "../../../components/ticker/list-table-view";
import {
  CASH_SYMBOL,
  formatAllocationDrift,
  formatAllocationWeight,
  type PortfolioAllocation,
} from "../../../portfolio/allocation";
import { priceColor, shownPriceColor } from "../../../theme/colors";
import { formatCompact, formatCompactAmount, formatPercentRaw } from "../../../utils/format";

/** The cash line's row, which the cursor lands on so it takes a target like a holding. */
export const CASH_ROW_KEY = summaryRowKey("cash");

type SummaryCell = TickerTableSummaryRow["cells"][string];

/** A signed figure as the rows color one: green or red, none once it rounds to zero. */
function signed(text: string, value: number | null | undefined): SummaryCell {
  return value != null && Number.isFinite(value) && /[1-9]/.test(text) ? { text, color: priceColor(value), value } : { text, value: value ?? null };
}

/** What the TOTAL row adds up beside the allocation: the day and P&L the header shows. */
export interface AllocationRowTotals {
  cost: number | null;
  dayPnl: number | null;
  dayPnlPct: number | null;
  pnl: number | null;
  pnlPct: number | null;
}

/**
 * The CASH and TOTAL rows under a book's holdings, as `portfolio show`
 * prints them: cash with its weight, target, drift and the trade that
 * reaches it, so the trades add up to nothing once the targets add up to the
 * whole; then the total, cash included, with the day and P&L. Cash trades in
 * its own currency, so its TRADE is the amount. Null rows when the book has
 * neither cash nor a target.
 */
export function allocationSummaryRows(
  allocation: Pick<PortfolioAllocation, "cash" | "total" | "weightBasis" | "targetSum">,
  totals: AllocationRowTotals,
  { cashCurrency, currency }: { cashCurrency?: string | null; currency: string },
): TickerTableSummaryRow[] {
  const rows: TickerTableSummaryRow[] = [];
  const { cash } = allocation;
  if (cash) {
    const trade = formatCompactAmount(cash.tradeValue ?? undefined, { signed: true });
    rows.push({
      id: "cash",
      selectable: true,
      cells: {
        ticker: { text: cashCurrency && cashCurrency !== currency ? `${CASH_SYMBOL} ${cashCurrency}` : CASH_SYMBOL },
        mkt_value: { text: formatCompactAmount(cash.value), value: cash.value },
        weight: { text: formatAllocationWeight(cash.weight), value: cash.weight },
        target_weight: { text: formatAllocationWeight(cash.targetWeight), value: cash.targetWeight },
        drift: signed(formatAllocationDrift(cash.drift), cash.drift),
        trade: signed(trade, cash.tradeValue),
        trade_value: signed(trade, cash.tradeValue),
      },
    });
  }
  const weight = allocation.weightBasis === "total" && allocation.total != null && allocation.total > 0 ? 100 : null;
  const day = formatCompactAmount(totals.dayPnl ?? undefined, { signed: true });
  const pnl = formatCompactAmount(totals.pnl ?? undefined, { signed: true });
  const percent = (value: number | null) => value != null && Number.isFinite(value)
    ? { text: formatPercentRaw(value), color: shownPriceColor(value, 2), value }
    : { text: "—", value: null };
  rows.push({
    id: "total",
    cells: {
      ticker: { text: "TOTAL" },
      change_pct: percent(totals.dayPnlPct),
      cost_basis: { text: totals.cost != null && Number.isFinite(totals.cost) ? formatCompact(totals.cost) : "—", value: totals.cost },
      mkt_value: { text: formatCompactAmount(allocation.total ?? undefined), value: allocation.total },
      weight: { text: formatAllocationWeight(weight), value: weight },
      target_weight: { text: formatAllocationWeight(allocation.targetSum), value: allocation.targetSum },
      day_pnl: signed(day, totals.dayPnl),
      pnl: signed(pnl, totals.pnl),
      pnl_pct: percent(totals.pnlPct),
    },
  });
  return rows;
}
