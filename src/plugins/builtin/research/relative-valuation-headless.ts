import { formatPriceEarnings, NOT_MEANINGFUL, PRICE_EARNINGS_NOTICE } from "../../../utils/price-earnings";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import { EXTENDED_SESSION_LABELS, type ExtendedSession } from "../../../market-data/market/status";
import { formatCompact, formatCurrency, formatLevelPercent, formatNumber, formatPercent, formatPercentRaw } from "../../../utils/format";
import { loadHeadlessFinancials, loadHeadlessSymbols } from "../shared/headless-market-data";
import { quoteFreshnessFields } from "../shared/report-freshness";
import { RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE, RELATIVE_VALUATION_STALE_QUOTE_NOTICE, relativeValuationValues } from "./relative-valuation-model";
import { paneSchemas } from "./headless-schema";

const price = (value: unknown, row: Record<string, unknown>) => (
  value == null || !row.currency ? "-" : formatCurrency(Number(value), String(row.currency))
);
const percent = (value: unknown) => value == null ? "-" : formatPercentRaw(Number(value));

/** The pre-market or after-hours print and its move from the regular close in Last, for the peers that have one. */
function extendedColumn(session: ExtendedSession): HeadlessPaneColumn {
  return {
    key: "extendedPrice",
    header: EXTENDED_SESSION_LABELS[session],
    align: "right",
    format: (value, row) => row.extendedSession === session && typeof value === "number"
      ? `${price(value, row)} ${percent(row.extendedChangePercent)}`
      : "-",
  };
}

const QUOTE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker" },
  { key: "price", header: "Last", align: "right", format: price },
  { key: "changePercent", header: "Chg%", align: "right", format: percent },
];

const VALUATION_COLUMNS: HeadlessPaneColumn[] = [
  // In the currency each peer's cap is in, which exports write in the header or beside the figure.
  { key: "marketCap", header: "Mkt Cap", align: "right", unitKey: "marketCapCurrency",
    format: (value, row) => value == null ? "-" : `${formatCompact(Number(value), { fixedDecimals: true })}${row.marketCapCurrency ? ` ${row.marketCapCurrency}` : ""}` },
  ...([ ["trailingPE", "P/E"], ["forwardPE", "Fwd P/E"] ] as const).map(([key, header]) => ({
    key, header, align: "right" as const,
    format: (_value: unknown, row: Record<string, unknown>) => {
      const values = row as Partial<ReturnType<typeof relativeValuationValues>>;
      return formatPriceEarnings(values.notMeaningful?.[key] ? NOT_MEANINGFUL : values.reportedMultiples?.[key]);
    },
  })),
  ...[["evSales", "EV/S"]].map(([key, header]) => ({
    key: key!, header: header!, align: "right" as const,
    format: (value: unknown) => value == null ? "-" : formatNumber(Number(value), 1),
  })),
  ...[["fcfYield", "FCF Yield"], ["revenueGrowth", "Quarter Revenue YoY"], ["operatingMargin", "TTM Op Margin"]].map(([key, header]) => ({
    key: key!, header: header!, align: "right" as const,
    format: (value: unknown) => value == null ? "-" : key === "revenueGrowth" ? formatPercent(Number(value)) : formatLevelPercent(Number(value)),
  })),
];

export const relativeValuationHeadless: HeadlessPaneDefinition<"rows"> = {
  ...paneSchemas["relative-valuation-pane"],
  shape: "rows",
  describe: ({ symbols }) => `Relative Valuation | ${symbols.join(", ")}`,
  columns: [...QUOTE_COLUMNS, ...VALUATION_COLUMNS],
  async load({ symbols }, ctx) {
    const loaded = await loadHeadlessSymbols(symbols, ctx, (symbol) => loadHeadlessFinancials(ctx, symbol));
    const rows = loaded.entries.map(({ symbol, data }) => ({ symbol, ...relativeValuationValues(data), ...quoteFreshnessFields(data?.quote) }));
    const unavailableSymbols = [...loaded.unavailableSymbols, ...rows.filter((row) => ![
      row.marketCap, row.trailingPE, row.forwardPE, row.evSales, row.fcfYield, row.revenueGrowth, row.operatingMargin,
    ].some((value) => value != null)).map(({ symbol }) => symbol)];
    const staleSymbols = rows.filter((row) => row.quoteStale).map((row) => row.symbol);
    const staleFundamentalsSymbols = rows.filter((row) => row.fundamentalsProvenance?.stale).map((row) => row.symbol);
    const errors = [...loaded.errors,
      ...staleSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_QUOTE_NOTICE}`),
      ...staleFundamentalsSymbols.map((symbol) => `${symbol}: ${RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE}`),
    ];
    // Last and Chg% are the regular session; an extended print gets a column only when a peer has one.
    const extendedSessions = (["PRE", "POST"] as const).filter((session) => rows.some((row) => row.extendedSession === session));
    return {
      rows, unavailableSymbols, errors, complete: unavailableSymbols.length === 0 && errors.length === 0,
      ...(extendedSessions.length > 0 ? { columns: [...QUOTE_COLUMNS, ...extendedSessions.map(extendedColumn), ...VALUATION_COLUMNS] } : {}),
      metadata: {
        staleSymbols,
        staleFundamentalsSymbols,
        quoteBasis: "Stale quote fields are excluded from comparison; reportedQuote retains the rejected observation and quoteAsOf retains its source timestamp.",
        priceBasis: "price, change and changePercent are the regular session: after the close, its close and that close's move. A pre-market or after-hours print is in extendedPrice, extendedChange and extendedChangePercent, measured from that close. marketCap, the P/E multiples, evSales (through the equity part of the enterprise value) and fcfYield are measured at that regular session price.",
        fundamentalsBasis: "Provider multiples and operating metrics retain independent fundamentalsProvenance. Retrieval time does not establish the valuation date.",
        notices: rows.some((row) => Object.keys(row.notMeaningful).length > 0
          || Object.values(row.reportedMultiples).some((value) => value != null && value <= 0)) ? [PRICE_EARNINGS_NOTICE] : [],
        multipleBasis: "Comparable P/E fields require a positive finite multiple over positive EPS; notMeaningful says why one is null, and reportedMultiples preserves the finite provider values.",
        marketCapBasis: "Market caps retain their own currency and source. Fundamentals retrieval time is not a valuation date; quote timestamps do not date fallback caps.",
      },
    };
  },
};
