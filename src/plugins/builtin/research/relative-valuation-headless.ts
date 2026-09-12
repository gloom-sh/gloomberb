import { formatPriceEarnings, PRICE_EARNINGS_NOTICE } from "../../../utils/price-earnings";
import type { HeadlessPaneDefinition } from "../../../types/headless";
import { formatCurrency, formatNumber, formatPercent } from "../../../utils/format";
import { loadHeadlessFinancials, loadHeadlessSymbols } from "../shared/headless-market-data";
import { RELATIVE_VALUATION_STALE_QUOTE_NOTICE, relativeValuationValues } from "./relative-valuation-model";
import { paneSchemas } from "./headless-schema";

export const relativeValuationHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["relative-valuation-pane"],
  shape: "rows",
  describe: ({ symbols }) => `Relative Valuation | ${symbols.join(", ")}`,
  columns: [
    { key: "symbol", header: "Ticker" },
    { key: "price", header: "Last", align: "right", format: (value, row) => value == null || !row.currency ? "-" : formatCurrency(Number(value), String(row.currency)) },
    ...([ ["trailingPE", "P/E"], ["forwardPE", "Fwd P/E"] ] as const).map(([key, header]) => ({
      key, header, align: "right" as const,
      format: (_value: unknown, row: Record<string, unknown>) => formatPriceEarnings((row.reportedMultiples as ReturnType<typeof relativeValuationValues>["reportedMultiples"] | undefined)?.[key]),
    })),
    ...[["evSales", "EV/S"]].map(([key, header]) => ({
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
    const staleSymbols = rows.filter((row) => row.quoteStale).map((row) => row.symbol);
    const errors = [...loaded.errors, ...staleSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_QUOTE_NOTICE}`)];
    return { rows, unavailableSymbols, errors, complete: unavailableSymbols.length === 0 && errors.length === 0, metadata: {
      staleSymbols,
      quoteBasis: "Stale quote fields are excluded from comparison; reportedQuote retains the rejected observation and quoteAsOf retains its source timestamp.",
      fundamentalsBasis: "Provider multiples and operating metrics retain independent fundamentalsProvenance. Retrieval time does not establish the valuation date.",
      notices: rows.some((row) => Object.values(row.reportedMultiples).some((value) => value != null && value <= 0)) ? [PRICE_EARNINGS_NOTICE] : [],
      multipleBasis: "Comparable P/E fields require a positive finite multiple; reportedMultiples preserves the finite provider values.",
      marketCapBasis: "Market caps retain their own currency and source. Fundamentals retrieval time is not a valuation date; quote timestamps do not date fallback caps.",
    } };

  },
};
