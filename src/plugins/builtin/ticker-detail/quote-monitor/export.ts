import type { Quote } from "../../../../types/financials";
import { serializeCsv } from "../../../../utils/csv";
import { canonicalTickerKey } from "../../../../utils/exchanges";
import { changeBasisLabel, quoteChangeBasis } from "../../../../market-data/market/change-basis";
import { getQuoteSessionFields } from "../../../../market-data/market/status";
import { QUOTE_EXPORT_IDENTITY_HEADERS, quoteExportIdentityCells } from "../../../../market-data/quotes/export-identity";

export interface QuoteMonitorExportEntry {
  /** The symbol as the board shows it (0005.HK). */
  symbol: string;
  /** The listing it was read as, when the board knows its venue. */
  instrument: { symbol: string; exchange?: string } | null;
  quote: Quote | null | undefined;
}

/** A figure without float noise: what a spreadsheet keeps. */
function figure(value: number | null | undefined): number | "" {
  return value == null || !Number.isFinite(value) ? "" : Number(value.toPrecision(12));
}

/**
 * The board's Export CSV, the row schema `fn QQ --csv` and `quote --csv`
 * write: each card's symbol, name, regular-session Last, change and percent
 * change as the card shows them (to two decimals), what the move is from,
 * then its session, feed, listing with its venue, unit, source and the time
 * its own price was observed.
 */
export function quoteMonitorCsv(entries: readonly QuoteMonitorExportEntry[], now = Date.now()): string {
  const rows = entries.map(({ symbol, instrument, quote }) => {
    const { price, change, changePercent } = getQuoteSessionFields(quote);
    const basis = quote ? quoteChangeBasis(quote) : null;
    const listing = instrument?.exchange ? canonicalTickerKey(instrument.symbol, instrument.exchange) : instrument?.symbol ?? symbol;
    return [
      symbol,
      quote?.name ?? "",
      figure(price),
      figure(change),
      changePercent == null || !Number.isFinite(changePercent) ? "" : Number(changePercent.toFixed(2)),
      basis ? changeBasisLabel(basis, now) : "",
      ...quoteExportIdentityCells(listing, quote, now),
    ];
  });
  return serializeCsv([["Ticker", "Name", "Last", "Change", "Change %", "Chg Basis", ...QUOTE_EXPORT_IDENTITY_HEADERS], ...rows], { excelCompatible: true });
}
