import type { DataProvider, SecFilingItem } from "../../../types/data-provider";
import { parseInsiderFiling, type ParsedInsiderFiling } from "./model";
import { isInsiderForm } from "./insider-data";
import { filesAsForeignPrivateIssuer } from "./issuer";

// Recent EDGAR dumps cap at 1,000 mixed forms; older archives are read until
// this many filings or the company's history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;

/** The company's own filings `fn INS` reads by default, and `insider` sums up as it does. */
export const INSIDER_REPORT_FILINGS = 20;

/**
 * Form 4 filings asked for at a time, the most `fn INS` reads: a company whose
 * Form 4s are its own is read from one page, and every limit shares it.
 */
const FORM4_PAGE = 100;
/** Form 4, which the service's filter matches with its amendment 4/A. */
const INSIDER_FORMS = ["4"] as const;

export interface InsiderFilingsLoad {
  /** The rows of the company's own Form 4 filings, newest first. */
  parsed: ParsedInsiderFiling[];
  /** Every Form 4 listed was read, none is the company's own, and it reports as a foreign private issuer. */
  foreignPrivateIssuer: boolean;
  /** The SEC lists no filing of any form for the company. */
  noFilings: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Insider filing load was aborted.");
}

/**
 * Form 4 documents read at once: a list is read in a few round trips, not one
 * per filing, and never more than the service reads from the SEC at once.
 */
const CONTENT_READS_AT_ONCE = 4;

/** What the company files as, which only matters once none of its Form 4s is its own. */
interface InsiderIssuer {
  foreignPrivateIssuer: boolean;
  noFilings: boolean;
}

/** The company's Form 4s as they are listed, newest first, read further on demand. */
interface Form4Listing {
  /** The Form 4s listed so far. */
  forms: SecFilingItem[];
  /** Lists the next ones into `forms`; false when the list holds no more. */
  more(): Promise<boolean>;
  issuer(): Promise<InsiderIssuer>;
}

const issuerOf = (filings: ReadonlyArray<Pick<SecFilingItem, "form"> & { filingDate: Date | string }>): InsiderIssuer => ({
  foreignPrivateIssuer: filesAsForeignPrivateIssuer(filings),
  noFilings: filings.length === 0,
});

/** The company's whole list, filtered here: a source with no page of one form (`getSecFilingsPage`). */
async function wholeListForm4s(provider: DataProvider, symbol: string, exchange: string): Promise<Form4Listing> {
  if (!provider.getSecFilings) throw new Error("Insider filing data unavailable");
  const filings = await provider.getSecFilings(symbol, SEC_FILING_SCAN_LIMIT, exchange);
  return {
    forms: filings.filter((filing) => isInsiderForm(filing.form)),
    more: async () => false,
    issuer: async () => issuerOf(filings),
  };
}

/**
 * Pages of the company's Form 4s, picked by the source: PG's list is some
 * 6,000 filings of every form, read whole to keep its Form 4s. The first page
 * says what else the list holds by form (`newestByForm`), which tells a
 * foreign private issuer and a company with no filings at all; a source that
 * does not say has its whole list read for it, and only then.
 */
async function pagedForm4s(provider: DataProvider, symbol: string, exchange: string): Promise<Form4Listing> {
  const read = (offset: number) => provider.getSecFilingsPage!(symbol, { forms: INSIDER_FORMS, limit: FORM4_PAGE, offset }, exchange);
  const first = await read(0);
  let last = first;
  let offset = 0;
  // A source that predates the filter lists every form: the Form 4s among them are kept, the pages read on.
  const forms = first.filings.filter((filing) => isInsiderForm(filing.form));
  return {
    forms,
    async more() {
      if (!last.hasMore || last.filings.length === 0) return false;
      // A next page that is not past this one would answer the same filings again, and again: the list ends here.
      if (!Number.isSafeInteger(last.nextOffset) || last.nextOffset <= offset) return false;
      offset = last.nextOffset;
      last = await read(offset);
      forms.push(...last.filings.filter((filing) => isInsiderForm(filing.form)));
      return last.filings.length > 0;
    },
    async issuer() {
      if (first.newestByForm) {
        return issuerOf(Object.entries(first.newestByForm).map(([form, filingDate]) => ({ form, filingDate })));
      }
      return (await wholeListForm4s(provider, symbol, exchange)).issuer();
    },
  };
}

const bareCik = (cik: string | null | undefined) => cik?.trim().replace(/^0+/, "") ?? "";

/**
 * A Form 4 the service already read for the list and found to be about
 * another issuer's shares: one the company filed as an owner (Berkshire's of
 * Occidental), which INS leaves out, so its document is never read.
 */
function summarizedAsOtherIssuer(filing: SecFilingItem): boolean {
  const issuer = bareCik(filing.form4?.issuerCik);
  const company = bareCik(filing.cik);
  return /^\d+$/.test(issuer) && /^\d+$/.test(company) && issuer !== company;
}

/**
 * Reads the company's Form 4 filings newest first until `limit` of them are
 * its own, up to four documents at a time ahead of the one being looked at
 * and never more than are still wanted (one at a time, `insider OXY` took
 * 6-8 s for its 20). A form it filed as an owner of another company's shares
 * is left out: unread when the list's summary names that company, else read
 * and dropped, so a list of only those is read to the end before it can say
 * there are none.
 */
export async function loadParsedInsiderFilings(
  provider: DataProvider,
  symbol: string,
  options: { limit: number; exchange?: string; signal?: AbortSignal },
): Promise<InsiderFilingsLoad> {
  if (!provider.getSecFilings && !provider.getSecFilingsPage) throw new Error("Insider filing data unavailable");
  if (!provider.getSecFilingContent) throw new Error("Insider filing content unavailable");
  const readContent = provider.getSecFilingContent.bind(provider);
  const exchange = options.exchange ?? "";
  const listing = provider.getSecFilingsPage
    ? await pagedForm4s(provider, symbol, exchange)
    : await wholeListForm4s(provider, symbol, exchange);
  const { forms } = listing;
  const reads: Array<Promise<{ content: string | null } | null>> = [];
  const read = (index: number) => reads[index] ??= readContent(forms[index]!).then(
    (content) => ({ content }),
    () => {
      // Intentional ignore: an unread filing may be the company's own, so it stays as a row that says it was not read.
      return null;
    },
  );

  const parsed: ParsedInsiderFiling[] = [];
  let own = 0;
  for (let index = 0; own < options.limit; index += 1) {
    throwIfAborted(options.signal);
    if (index >= forms.length && !await listMore(listing, index)) break;
    throwIfAborted(options.signal);
    const filing = forms[index]!;
    if (summarizedAsOtherIssuer(filing)) continue;
    // Never more in flight than filings still wanted: each read is at most one of them.
    const window = Math.min(CONTENT_READS_AT_ONCE, options.limit - own);
    for (let ahead = index, queued = 0; ahead < forms.length && queued < window; ahead += 1) {
      if (summarizedAsOtherIssuer(forms[ahead]!)) continue;
      read(ahead);
      queued += 1;
    }
    const result = await read(index);
    throwIfAborted(options.signal);
    if (!result) {
      parsed.push({ filing, transaction: null, isLoading: false });
      own += 1;
      continue;
    }
    const entries = parseInsiderFiling(filing, result.content);
    if (entries.length === 0) continue;
    parsed.push(...entries);
    own += 1;
  }
  // A company with a Form 4 of its own has filings and files them as a domestic issuer.
  if (own > 0) return { parsed, foreignPrivateIssuer: false, noFilings: false };
  return { parsed, ...await listing.issuer() };
}

/** Lists on until the list holds a Form 4 at `index`; false once it has no more. */
async function listMore(listing: Form4Listing, index: number): Promise<boolean> {
  while (index >= listing.forms.length) {
    if (!await listing.more()) return false;
  }
  return true;
}
