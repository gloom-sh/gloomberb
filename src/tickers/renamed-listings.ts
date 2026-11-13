import { formatShortDate } from "../utils/datetime-format";
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
  /** The venue's symbol suffix, as `quote` takes it (`.SA`). */
  suffix: string;
  exchange: string;
  /** Its name now. */
  name: string;
  /** The names people still search for, the one it went by first: its brand, then its legal name. */
  formerNames: readonly [string, ...string[]];
  /** The day a class that no longer trades was converted into the `to` line (YYYY-MM-DD). */
  convertedOn?: string;
}

/** The name it went by: "Eletrobras". */
function renamedListingFormerName(listing: RenamedListing): string {
  return listing.formerNames[0];
}

/**
 * Checked in, each from the issuer's own notice. Eletrobras (Centrais
 * Elétricas Brasileiras S.A.) renamed itself AXIA Energia in November 2025,
 * and each of its B3 lines took the new code: ELET3 AXIA3, the class B
 * preferred ELET6 AXIA6, the class A preferred ELET5 AXIA5. On 5 Jun 2026,
 * moving to the Novo Mercado, AXIA converted both preferred classes into its
 * common shares, which trade as AXIA3 (AXIA's release of 9 Jun 2026), so
 * the preferred codes, old and new, lead there. Its ADSs' change (EBR to
 * AXIA) is in the US history already. A name leads to the common shares,
 * listed first.
 */
const ELETROBRAS = ["Eletrobras", "Centrais Elétricas Brasileiras"] as const;
const AXIA_PREFERRED_CONVERTED = "2026-06-05";
const RENAMED_LISTINGS: readonly RenamedListing[] = [
  { from: "ELET3", to: "AXIA3", suffix: ".SA", exchange: "B3", name: "AXIA Energia", formerNames: ELETROBRAS },
  ...["ELET6", "AXIA6", "ELET5", "AXIA5"].map((from): RenamedListing => ({ from, to: "AXIA3", suffix: ".SA", exchange: "B3",
    name: "AXIA Energia", formerNames: ELETROBRAS, convertedOn: AXIA_PREFERRED_CONVERTED })),
];

/** "5 Jun 2026". */
function conversionDay(date: string): string {
  return formatShortDate(date, { utc: true });
}

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
  return words ? RENAMED_LISTINGS.find((listing) => listing.formerNames.some((name) => normalizeSearchText(name) === words)) ?? null : null;
}

/**
 * "It is now AXIA3.SA (AXIA Energia, formerly Eletrobras): `gloom quote
 * AXIA3.SA`.", after the line naming the old symbol; for a converted class,
 * "It was converted into AXIA3.SA on 5 Jun 2026 ...".
 */
export function renamedListingHint(listing: RenamedListing): string {
  const now = renamedListingSymbol(listing);
  const named = `${now} (${listing.name}, formerly ${renamedListingFormerName(listing)})`;
  return listing.convertedOn
    ? `It was converted into ${named} on ${conversionDay(listing.convertedOn)}: \`gloom quote ${now}\`.`
    : `It is now ${named}: \`gloom quote ${now}\`.`;
}

/** What search says the new line was: "Eletrobras (ELET3)", or "Eletrobras (ELET6, converted 5 Jun 2026)". */
export function renamedListingFormerLine(listing: RenamedListing): string {
  const converted = listing.convertedOn ? `, converted ${conversionDay(listing.convertedOn)}` : "";
  return `${renamedListingFormerName(listing)} (${listing.from}${converted})`;
}

/**
 * "Read ELET3.SA as AXIA3.SA: Eletrobras is AXIA Energia now.", or "Read
 * "eletrobras" as ..." for its name; for a converted class, "Read ELET6 as
 * AXIA3.SA: those preferred shares were converted into AXIA Energia's common
 * shares on 5 Jun 2026."
 */
export function renamedListingReadAs(typed: string, listing: RenamedListing): string {
  const word = typed.trim();
  // A name is quoted, as every name read as a listing is; the CLI puts it back in the user's spelling.
  const shown = listing.formerNames.some((name) => normalizeSearchText(word) === normalizeSearchText(name)) ? `"${word}"` : word;
  const now = renamedListingSymbol(listing);
  return listing.convertedOn
    ? `Read ${shown} as ${now}: those preferred shares were converted into ${listing.name}'s common shares on ${conversionDay(listing.convertedOn)}.`
    : `Read ${shown} as ${now}: ${renamedListingFormerName(listing)} is ${listing.name} now.`;
}
