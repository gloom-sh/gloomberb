import { normalizeSearchText } from "./search/ranking";

/**
 * A listing abroad whose company renamed itself and moved to a new symbol:
 * the change history the data service keeps is of US listings, so `quote
 * ELET3.SA` found nothing and its hint searched for the dead symbol again.
 */
export interface RenamedListing {
  /** The symbol it left, as the venue writes it. */
  from: string;
  /** The symbol it trades as now. */
  to: string;
  /** Yahoo's suffix for the venue, as `quote` takes it (`.SA`). */
  suffix: string;
  exchange: string;
  /** Its name now. */
  name: string;
  /** The name people still search for. */
  formerName: string;
}

/**
 * Checked in, each from the issuer's own notice. Eletrobras renamed itself
 * AXIA Energia in November 2025 and its B3 common shares moved from ELET3 to
 * AXIA3; its ADSs' change (EBR to AXIA) is in the US history already.
 */
const RENAMED_LISTINGS: readonly RenamedListing[] = [
  { from: "ELET3", to: "AXIA3", suffix: ".SA", exchange: "B3", name: "AXIA Energia", formerName: "Eletrobras" },
];

/** `AXIA3.SA`: the new listing as `quote` takes it. */
export function renamedListingSymbol(listing: RenamedListing): string {
  return `${listing.to}${listing.suffix}`;
}

/**
 * The renamed listing a symbol (`ELET3`, `ELET3.SA`, `ELET3:B3`) or a name
 * (`eletrobras`) means, else null.
 */
export function renamedListingFor(query: string): RenamedListing | null {
  const typed = query.trim().toUpperCase();
  if (!typed) return null;
  const bySymbol = RENAMED_LISTINGS.find((listing) =>
    typed === listing.from || typed === `${listing.from}${listing.suffix}` || typed === `${listing.from}:${listing.exchange}`);
  if (bySymbol) return bySymbol;
  const words = normalizeSearchText(query);
  return words ? RENAMED_LISTINGS.find((listing) => normalizeSearchText(listing.formerName) === words) ?? null : null;
}

/** "It is now AXIA3.SA (AXIA Energia, formerly Eletrobras): `gloom quote AXIA3.SA`.", after the line naming the old symbol. */
export function renamedListingHint(listing: RenamedListing): string {
  const now = renamedListingSymbol(listing);
  return `It is now ${now} (${listing.name}, formerly ${listing.formerName}): \`gloom quote ${now}\`.`;
}

/** "Read ELET3.SA as AXIA3.SA: Eletrobras is AXIA Energia now.", or "Read "eletrobras" as ..." for its name. */
export function renamedListingReadAs(typed: string, listing: RenamedListing): string {
  const word = typed.trim();
  // A name is quoted, as every name read as a listing is; the CLI puts it back in the user's spelling.
  const shown = normalizeSearchText(word) === normalizeSearchText(listing.formerName) ? `"${word}"` : word;
  return `Read ${shown} as ${renamedListingSymbol(listing)}: ${listing.formerName} is ${listing.name} now.`;
}
