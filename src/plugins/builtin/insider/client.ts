import type { DataProvider } from "../../../types/data-provider";
import { parseInsiderFiling, type ParsedInsiderFiling } from "./model";
import { isInsiderForm } from "./insider-data";
import { filesAsForeignPrivateIssuer } from "./issuer";

// Recent EDGAR dumps cap at 1,000 mixed forms; older archives are read until
// this many filings or the company's history ends.
const SEC_FILING_SCAN_LIMIT = 20_000;

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
 * Reads the company's Form 4 filings newest first, one at a time, until
 * `limit` of them are its own. A form it filed as an owner of another
 * company's shares is read and left out, so a list of only those is read to
 * the end before it can say there are none.
 */
export async function loadParsedInsiderFilings(
  provider: DataProvider,
  symbol: string,
  options: { limit: number; exchange?: string; signal?: AbortSignal },
): Promise<InsiderFilingsLoad> {
  if (!provider.getSecFilings) throw new Error("Insider filing data unavailable");
  if (!provider.getSecFilingContent) throw new Error("Insider filing content unavailable");
  const filings = await provider.getSecFilings(symbol, SEC_FILING_SCAN_LIMIT, options.exchange ?? "");

  const parsed: ParsedInsiderFiling[] = [];
  let own = 0;
  for (const filing of filings) {
    if (own >= options.limit) break;
    if (!isInsiderForm(filing.form)) continue;
    throwIfAborted(options.signal);
    let content: string | null;
    try {
      content = await provider.getSecFilingContent(filing);
    } catch {
      throwIfAborted(options.signal);
      // An unread filing may be the company's own; it stays as a row that says so.
      parsed.push({ filing, transaction: null, isLoading: false });
      own += 1;
      continue;
    }
    const entries = parseInsiderFiling(filing, content);
    if (entries.length === 0) continue;
    parsed.push(...entries);
    own += 1;
  }
  return { parsed, foreignPrivateIssuer: own === 0 && filesAsForeignPrivateIssuer(filings), noFilings: filings.length === 0 };
}
