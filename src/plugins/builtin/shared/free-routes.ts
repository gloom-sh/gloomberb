import type { HeadlessPaneContext } from "../../../types/headless";
import { filingFormMatches, SEC_FILING_FETCH_LIMIT } from "../sec/forms";
import { resolveHeadlessInstrument } from "./headless-market-data";

/** Filings read first: a few hundred hold a year of an issuer's 8-Ks; the full list follows only when they hold none. */
const FIRST_FILINGS = 200;

/**
 * Whether the SEC lists a filing of the form for the company, as
 * `filings <ticker> --form <form>` would list it: ASML files 20-F and 6-K, so
 * a route to its 10-Ks or 8-Ks answers "No filings".
 */
export async function filesForm(symbol: string, form: string, context: HeadlessPaneContext): Promise<boolean> {
  const { symbol: ticker, exchange } = await resolveHeadlessInstrument(context, symbol);
  for (const count of [FIRST_FILINGS, SEC_FILING_FETCH_LIMIT]) {
    const filings = await context.marketData.getSecFilings?.(ticker, count, exchange) ?? [];
    if (filings.some((filing) => filingFormMatches(filing.form, form))) return true;
    if (filings.length < count) return false;
  }
  return false;
}
