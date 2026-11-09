import { looksLikeTicker } from "../shared/ticker-company";

/**
 * What the pane asks the registry for a search box's term.
 *
 * - `latest`: no term, the latest studies.
 * - `pending`: a term written as a ticker whose company is still being looked up.
 * - `company`: a ticker's company, searched as the lead sponsor of its studies
 *   (`TRIAL CRMD` is CorMedix's trials, never studies of "Cardiac Rhythm
 *   Management" devices that happen to abbreviate to CRMD).
 * - `mentions`: a ticker whose company leads no study, searched as text after all.
 * - `text`: anything else, as typed; a company's name of several words as one phrase.
 */
export type TrialSearch =
  | { kind: "latest" }
  | { kind: "pending"; ticker: string }
  | { kind: "company"; ticker: string; company: string; sponsor: string }
  | { kind: "mentions"; ticker: string; company: string; term: string }
  | { kind: "text"; term: string };

/** A search written as a ticker is, in capitals (`CRMD`, `BRK.B`); `pain` or `crmd` is a word to search for first. */
export function writtenAsTicker(term: string): boolean {
  const text = term.trim();
  return looksLikeTicker(text) && text === text.toUpperCase();
}

/**
 * Words a company's name ends with and a condition's or a drug's does not:
 * a legal form, or what a drug maker calls itself.
 */
const COMPANY_NAME_END = /\b(?:therapeutics|pharmaceuticals?|pharma|biopharma(?:ceuticals)?|biosciences?|biotherapeutics|biotech(?:nology)?|biologics|biomedical|bio|medicines|oncology|genomics|sciences|laboratories|labs|holdings?|group|inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|ag|sa|nv|bv|gmbh|kgaa|se|ab|asa|a\/s)\.?$/i;

/**
 * The term as the registry is asked it. An unquoted company name of several
 * words (`Viking Therapeutics`) is one phrase: word by word the registry also
 * matches studies that name a Viking and some therapeutics. Anything quoted,
 * written with the registry's operators, or one word stays as typed.
 */
export function registryTerm(term: string): string {
  const text = term.trim().replace(/\s+/g, " ");
  if (!text.includes(" ") || /["()[\]]/.test(text) || /\b(?:AND|OR|NOT)\b/.test(text)) return text;
  return COMPANY_NAME_END.test(text) ? `"${text}"` : text;
}

/** Words a listing's name carries that a sponsor's registry name often does not: Pharming Group files as Pharming Technologies. */
const LISTING_NAME_TAIL = /\s+(?:group|holdings?)$/i;

/** The name a company's studies are searched under as their lead sponsor: its name without a group's or holding's tail. */
export function leadSponsorName(company: string): string {
  const name = company.trim().replace(/\s+/g, " ");
  return name.replace(LISTING_NAME_TAIL, "") || name;
}

/**
 * The search for `term`. `company` is the ticker's company once looked up
 * (null: no company trades under it; undefined: not looked up), and
 * `companyLeadsNone` says its sponsor search came back empty with no filter
 * narrowing it.
 */
export function trialSearch(term: string, company: string | null | undefined, companyLeadsNone: boolean): TrialSearch {
  const text = term.trim();
  if (!text) return { kind: "latest" };
  const ticker = text.toUpperCase();
  if (company && looksLikeTicker(text)) {
    return companyLeadsNone
      ? { kind: "mentions", ticker, company, term: text }
      : { kind: "company", ticker, company, sponsor: leadSponsorName(company) };
  }
  if (company === undefined && writtenAsTicker(text)) return { kind: "pending", ticker };
  return { kind: "text", term: registryTerm(text) };
}

/** What the header says the list is, when it is not the term as typed: the company searched, or that it leads none. */
export function trialSearchScope(search: TrialSearch): string | null {
  if (search.kind === "company") return `Lead sponsor: ${search.company} (${search.ticker})`;
  if (search.kind === "mentions") return `${search.company} (${search.ticker}) leads no trials; studies that mention ${search.term}`;
  return null;
}
