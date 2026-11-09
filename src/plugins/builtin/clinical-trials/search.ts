import { looksLikeTicker, type ListedCompany } from "../shared/ticker-company";

/**
 * What the pane asks the registry for a search box's term.
 *
 * - `latest`: no term, the latest studies.
 * - `pending`: a term written as a ticker whose company is still being looked up.
 * - `company`: a healthcare company's ticker, searched as the lead sponsor of
 *   its studies (`TRIAL CRMD` is CorMedix's trials, never studies of "Cardiac
 *   Rhythm Management" devices that happen to abbreviate to CRMD).
 * - `mentions`: a ticker whose company leads no study under any name it is
 *   searched by, searched as text after all.
 * - `text`: anything else, as typed; a company's name of several words as one
 *   phrase. A ticker of a company outside healthcare too: `TRIAL AMD` is age-related
 *   macular degeneration, not Advanced Micro Devices.
 */
export type TrialSearch =
  | { kind: "latest" }
  | { kind: "pending"; ticker: string }
  | { kind: "company"; ticker: string; company: string; sponsor: string }
  | { kind: "mentions"; ticker: string; company: string; sponsor: string; term: string }
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
 * Large sponsors the registry files under another name than their listing's,
 * by the listing's full name: Moderna is ModernaTX, GSK is GlaxoSmithKline,
 * Takeda Pharmaceutical is Takeda. Merck & Co. files as Merck Sharp & Dohme and
 * Merck KGaA as itself, so neither is the other's "Merck".
 */
const SPONSOR_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^moderna\b/i, "ModernaTX"],
  [/^(?:gsk|glaxosmithkline)\b/i, "GlaxoSmithKline"],
  [/^takeda\b/i, "Takeda"],
  [/^merck\s*&\s*co\b/i, "Merck Sharp & Dohme"],
  [/^merck\s+(?:kgaa|kommanditgesellschaft)\b/i, "Merck KGaA"],
];

/** "Pharmaceutical(s)" at the end of a name, which a sponsor's registry name often goes without. */
const PHARMACEUTICAL_TAIL = /\s+pharmaceuticals?$/i;

/**
 * The names a company's studies are searched under as their lead sponsor, in
 * turn while each finds none: its registry name for a large sponsor filed
 * under another, else its name, then that name without a trailing
 * "Pharmaceutical(s)".
 */
export function leadSponsorNames(company: Pick<ListedCompany, "name" | "legalName">): string[] {
  const alias = SPONSOR_ALIASES.find(([pattern]) => pattern.test(company.legalName.trim()) || pattern.test(company.name.trim()))?.[1];
  if (alias) return [alias];
  const name = leadSponsorName(company.name);
  const short = name.replace(PHARMACEUTICAL_TAIL, "");
  return short && short !== name ? [name, short] : [name];
}

/**
 * The search for `term`. `company` is the ticker's company once looked up
 * (null: no company trades under it; undefined: not looked up), and
 * `sponsorsFoundNone` how many of its lead sponsor names (leadSponsorNames)
 * came back empty with no filter narrowing them.
 */
export function trialSearch(term: string, company: ListedCompany | null | undefined, sponsorsFoundNone: number): TrialSearch {
  const text = term.trim();
  if (!text) return { kind: "latest" };
  const ticker = text.toUpperCase();
  if (company?.healthcare && looksLikeTicker(text)) {
    const names = leadSponsorNames(company);
    const sponsor = names[Math.min(sponsorsFoundNone, names.length - 1)]!;
    return sponsorsFoundNone >= names.length
      ? { kind: "mentions", ticker, company: company.name, sponsor, term: text }
      : { kind: "company", ticker, company: company.name, sponsor };
  }
  if (company === undefined && writtenAsTicker(text)) return { kind: "pending", ticker };
  return { kind: "text", term: registryTerm(text) };
}

/** What the search bar's meta says the list is: the company whose studies it is, as their lead sponsor. */
export function trialSearchScope(search: TrialSearch): string | null {
  return search.kind === "company" ? `${search.company} (${search.ticker}) · lead sponsor` : null;
}

/** Why a ticker's list is text matches: its company leads no study under the name searched. For a warning in the footer. */
export function trialSearchFallback(search: TrialSearch): string | null {
  return search.kind === "mentions" ? `No trials under lead sponsor ${search.sponsor}; text matches for ${search.term}` : null;
}
