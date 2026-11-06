import type { DataProvider } from "../../../types/data-provider";
import { parseInsiderFiling, type ParsedInsiderFiling } from "./model";
import { isInsiderForm } from "./insider-data";
import { filesAsForeignPrivateIssuer } from "./issuer";

// Recent EDGAR dumps cap at 1,000 mixed forms; older archives are read until
// this many filings or the company's history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;

/** The company's own filings `fn INS` reads by default, and `insider` sums up as it does. */
export const INSIDER_REPORT_FILINGS = 20;

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

/** Form 4 documents read at once: a list is read in a few round trips, not one per filing. */
const CONTENT_READS_AT_ONCE = 8;

/**
 * Reads the company's Form 4 filings newest first until `limit` of them are
 * its own, up to eight documents at a time ahead of the one being looked at
 * and never more than are still wanted (one at a time, `insider OXY` took
 * 6-8 s for its 20). A form it filed as an
 * owner of another company's shares is read and left out, so a list of only
 * those is read to the end before it can say there are none.
 */
export async function loadParsedInsiderFilings(
  provider: DataProvider,
  symbol: string,
  options: { limit: number; exchange?: string; signal?: AbortSignal },
): Promise<InsiderFilingsLoad> {
  if (!provider.getSecFilings) throw new Error("Insider filing data unavailable");
  if (!provider.getSecFilingContent) throw new Error("Insider filing content unavailable");
  const readContent = provider.getSecFilingContent.bind(provider);
  const filings = await provider.getSecFilings(symbol, SEC_FILING_SCAN_LIMIT, options.exchange ?? "");
  const forms = filings.filter((filing) => isInsiderForm(filing.form));
  const reads: Array<Promise<{ content: string | null } | null>> = [];
  // A read that fails is null: an unread filing may be the company's own, so it stays as a row that says so.
  const read = (index: number) => reads[index] ??= readContent(forms[index]!).then(
    (content) => ({ content }),
    () => null,
  );

  const parsed: ParsedInsiderFiling[] = [];
  let own = 0;
  for (let index = 0; index < forms.length && own < options.limit; index += 1) {
    throwIfAborted(options.signal);
    // Never more in flight than filings still wanted: each read is at most one of them.
    const window = Math.min(CONTENT_READS_AT_ONCE, options.limit - own);
    for (let ahead = index; ahead < Math.min(forms.length, index + window); ahead += 1) read(ahead);
    const filing = forms[index]!;
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
  return { parsed, foreignPrivateIssuer: own === 0 && filesAsForeignPrivateIssuer(filings), noFilings: filings.length === 0 };
}
