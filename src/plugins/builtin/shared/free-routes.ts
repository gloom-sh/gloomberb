import type { HeadlessPaneContext } from "../../../types/headless";
import { filingFormMatches } from "../sec/forms";
import { resolveHeadlessInstrument, resolveHeadlessIssuerListing } from "./headless-market-data";

/**
 * Whether the SEC lists a filing of the form for the company, as
 * `filings <ticker> --form <form>` would list it: ASML files 20-F and 6-K, so
 * a route to its 10-Ks or 8-Ks answers "No filings". The service filters by
 * form, so one filing answers; the form is checked again here, as a server
 * without the filter sends the newest filing of any form.
 */
export async function filesForm(symbol: string, form: string, context: HeadlessPaneContext): Promise<boolean> {
  const [{ symbol: ticker }, listing] = await Promise.all([
    resolveHeadlessInstrument(context, symbol),
    resolveHeadlessIssuerListing(context, symbol),
  ]);
  // A listing abroad whose company is unknown cannot be matched to a registrant, and `filings` says so.
  if (listing.exchange && !listing.name) return false;
  const { filings } = await context.apiClient.getCloudSecFilings(
    { ticker, ...listing, forms: [form], limit: 1 },
    { signal: context.signal },
  );
  return filings.some((filing) => filingFormMatches(filing.form, form));
}
