import type { SecFilingItem } from "../types/data-provider";
import { ProviderMissError } from "./provider-errors";

/** Legal forms and grouping words, which say nothing about which company a name is. */
const COMPANY_NAME_FILLER = new Set([
  "THE", "SA", "PLC", "LTD", "LIMITED", "CORP", "CORPORATION", "INC", "INCORPORATED", "NV", "AG", "SE",
  "HOLDING", "HOLDINGS", "GROUP", "COMPANY", "CO",
]);

/**
 * The first word of a company name that tells it apart, in capitals without
 * accents: "BANCO" for "Banco Santander, S.A.", "BP" for "BP p.l.c.". Null
 * when the name is only legal forms.
 */
function companyNameToken(name: string | null | undefined): string | null {
  const words = (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    // An initialism (S.A., N.V., p.l.c.) is one word; any other dot separates two (Amazon.com).
    .replace(/\b(?:[A-Z]\.){2,}/g, (initialism) => initialism.replaceAll(".", ""))
    .replace(/['\u2019]/g, "")
    .split(/[^A-Z0-9]+/);
  return words.find((word) => word && !COMPANY_NAME_FILLER.has(word)) ?? null;
}

/**
 * Whether two names are clearly different companies. Names that cannot be
 * compared count as the same, so only a plain conflict hides anything.
 */
export function areDifferentCompanies(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftToken = companyNameToken(left);
  const rightToken = companyNameToken(right);
  return !!leftToken && !!rightToken && leftToken !== rightToken;
}

export interface SecListing {
  /** The bare symbol, such as SAN. */
  symbol: string;
  /** The listing's canonical venue, such as EPA. */
  exchange: string;
  /** The listing's company, from its own quote. */
  name: string;
}

/** "No SEC filings found for Sanofi (EPA). The SEC lists SAN as Banco Santander, S.A. (NYSE)." */
export function secRegistrantMismatchMessage(listing: SecListing, registrantName: string, registrantExchange?: string | null): string {
  const registrant = registrantExchange ? `${registrantName} (${registrantExchange})` : registrantName;
  return `No SEC filings found for ${listing.name} (${listing.exchange}). The SEC lists ${listing.symbol} as ${registrant}${registrant.endsWith(".") ? "" : "."}`;
}

/** The SEC knows the listing's symbol as another company: SAN on EPA is Sanofi, SAN at the SEC is Banco Santander. */
export class SecRegistrantMismatchError extends ProviderMissError {
  constructor(readonly listing: SecListing, readonly registrantName: string) {
    super(secRegistrantMismatchMessage(listing, registrantName));
    this.name = "SecRegistrantMismatchError";
  }
}

/** The company the filings were filed by. */
function registrantName(filings: readonly SecFilingItem[]): string | null {
  return filings.map((filing) => filing.companyName?.trim()).find((name): name is string => !!name) ?? null;
}

/**
 * A lookup for a listing outside the US can answer with the US registrant of
 * the same symbol: a backend that predates venue-aware lookups ignores the
 * venue. Those filings are another company's, so they are refused.
 */
export function assertSecRegistrantMatches(filings: readonly SecFilingItem[], listing: SecListing): void {
  const registrant = registrantName(filings);
  if (registrant && areDifferentCompanies(listing.name, registrant)) {
    throw new SecRegistrantMismatchError(listing, registrant);
  }
}
