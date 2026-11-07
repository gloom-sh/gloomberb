import type { Quote } from "../../../../types/financials";
import type { HeadlessPaneRow } from "../../../../types/headless";
import { EXCEL_CSV_BOM } from "../../../../utils/csv";
import { exportedListingSymbol } from "../../../../portfolio/listed-symbol";
import type { BrokerNameOf } from "../../../../market-data/quotes/export-identity";
import { exportRowsTable, renderReportCsv } from "../../../../cli/report-tables";
import { deriveHeadlessFreshness } from "../../../../cli/pane-functions/freshness";
import { quoteMonitorColumns, quoteMonitorRow } from "./rows";

export interface QuoteMonitorExportEntry {
  /** The symbol as the board shows it (0005.HK). */
  symbol: string;
  /** The listing it was read as, when the board knows its venue. */
  instrument: { symbol: string; exchange?: string } | null;
  quote: Quote | null | undefined;
}

/** A card with no quote: its ticker and why the row is empty, as `fn QQ` names a symbol it found nothing for. */
function unquotedRow(symbol: string): HeadlessPaneRow {
  return { symbol, name: "", price: null, change: null, changePercent: null, unit: null, updatedAt: null, source: "" };
}

/**
 * The board's Export CSV, the file `fn QQ --csv` writes for the same tickers:
 * each card's listing with its venue (0005:HKEX), name, Last, the change and
 * percent change to the digits the board shows, what the move is from, its
 * session and feed, a yield's move in bp, then its unit, source and the time
 * its own price was observed. The closing source lines are left out, as every
 * pane export leaves them.
 */
export function quoteMonitorCsv(entries: readonly QuoteMonitorExportEntry[], now = Date.now(), brokerName?: BrokerNameOf): string {
  const rows = entries.map(({ symbol, instrument, quote }) => {
    const listing = instrument ? exportedListingSymbol(instrument.symbol, instrument.exchange, quote?.instrumentType) : symbol;
    return quote ? quoteMonitorRow(listing, quote, now, brokerName) : unquotedRow(listing);
  });
  const table = exportRowsTable("Quote Monitor", quoteMonitorColumns(rows), rows, { status: true, rowUnitKey: "unit" });
  const text = (value: unknown) => typeof value === "string" ? value : null;
  const rowIdentities = rows.map((row) => ({
    symbolOrSeries: text(row.symbol),
    currencyOrUnit: text(row.unit),
    asOf: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? new Date(row.updatedAt).toISOString() : null,
    source: text(row.source),
  }));
  const freshness = deriveHeadlessFreshness({ shape: "rows", freshness: { datesEachVenue: true } }, { rows }, now);
  return `${EXCEL_CSV_BOM}${renderReportCsv({ tables: [{ ...table, rowIdentities }], footer: [] }, freshness)}`;
}
