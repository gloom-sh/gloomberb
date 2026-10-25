import type { DataProvider } from "../../types/data-provider";
import type { Quote } from "../../types/financials";
import { logFailure } from "../../utils/log-failure";
import { isFuturesInstrument } from "../futures-contract";
import { changeBasisSessionDate, quoteChangeBasis } from "./change-basis";

/** History closes come as float32 (30.93000030517578) where the quote says 30.93: one close. */
const SAME_CLOSE_RELATIVE = 1e-5;

function sameClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * SAME_CLOSE_RELATIVE;
}

/**
 * The quote with its previous close dated by the listing's own daily closes,
 * where the venue's calendar cannot date it: a venue whose holidays the app
 * does not carry (LSE, Helsinki), or a year its calendar has not published.
 * The session the move is from is the latest daily close dated before the
 * move's own session, taken only when that close is the quote's previous
 * close, so a gap in the history never names the wrong day. Asks for history
 * only for such a quote; any other, and one whose history fails or disagrees,
 * comes back as it was.
 */
export async function withDatedPreviousClose(
  quote: Quote | null,
  listing: { symbol: string; exchange: string },
  dataProvider: Pick<DataProvider, "getPriceHistory">,
): Promise<Quote | null> {
  if (!quote || quoteChangeBasis(quote)?.kind !== "previous close" || isFuturesInstrument(quote.symbol, quote.instrumentType)) return quote;
  const previousClose = quote.previousClose;
  const sessionDate = changeBasisSessionDate(quote);
  if (previousClose == null || !Number.isFinite(previousClose) || !sessionDate) return quote;
  const points = await dataProvider.getPriceHistory(listing.symbol, listing.exchange, "1M")
    .catch(logFailure("market-data.dated-previous-close", "Read daily closes failed", []));
  const before = points
    .filter((point) => Number.isFinite(new Date(point.date).getTime()) && Number.isFinite(point.close))
    .map((point) => ({ date: new Date(point.date).toISOString().slice(0, 10), close: point.close }))
    .filter((point) => point.date < sessionDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .at(-1);
  return before && sameClose(before.close, previousClose) ? { ...quote, previousCloseDate: before.date } : quote;
}
