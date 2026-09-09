import type { HeadlessPaneDefinition } from "../../../types/headless";
import { formatCurrency, formatNumber, formatPercent } from "../../../utils/format";
import { loadHeadlessFinancials, loadHeadlessSymbols } from "../shared/headless-market-data";
import { relativeValuationValues } from "./relative-valuation-model";
import { paneSchemas } from "./headless-schema";

export const relativeValuationHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["relative-valuation-pane"],
  shape: "rows",
  describe: ({ symbols }) => `Relative Valuation | ${symbols.join(", ")}`,
  columns: [
    { key: "symbol", header: "Ticker" },
    { key: "price", header: "Last", align: "right", format: (value, row) => value == null || !row.currency ? "-" : formatCurrency(Number(value), String(row.currency)) },
    ...[["trailingPE", "P/E"], ["forwardPE", "Fwd P/E"], ["evSales", "EV/S"]].map(([key, header]) => ({
      key: key!, header: header!, align: "right" as const,
      format: (value: unknown) => value == null ? "-" : formatNumber(Number(value), 1),
    })),
    ...[["fcfYield", "FCF Yield"], ["revenueGrowth", "Revenue Growth"], ["operatingMargin", "Op Margin"]].map(([key, header]) => ({
      key: key!, header: header!, align: "right" as const,
      format: (value: unknown) => value == null ? "-" : formatPercent(Number(value)),
    })),
  ],
  async load({ symbols }, ctx) {
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadHeadlessFinancials(ctx, symbol));
    const rows = loaded.entries.map(({ symbol, data }) => ({ symbol, ...relativeValuationValues(data) }));
    const unavailableSymbols = [...loaded.unavailableSymbols, ...rows.filter((row) => ![
      row.marketCap, row.trailingPE, row.forwardPE, row.evSales, row.fcfYield, row.revenueGrowth, row.operatingMargin,
    ].some((value) => value != null)).map(({ symbol }) => symbol)];
    return { rows, unavailableSymbols, errors: loaded.errors };
  },
};
