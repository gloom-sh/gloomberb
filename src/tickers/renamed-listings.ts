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
  /**
   * The names people still search for, the one it went by first: its brand, then its legal name. Empty when the
   * old name went with another company (Tata Motors Limited is now the demerged commercial-vehicle business), so
   * only the old symbol, never a name, leads to this line.
   */
  formerNames: readonly string[];
  /** What the old line is called in a sentence when no former name leads to it: "Tata Motors". */
  formerLabel?: string;
  /** How the new line is written in the app's own key (`TMPV:NSE`), where the venue's suffix is not how it is read. */
  shownAs?: string;
  /** The day a class that no longer trades was converted into the `to` line (YYYY-MM-DD). */
  convertedOn?: string;
  /** The day the venue renamed the line, when its notice says so (YYYY-MM-DD). */
  renamedOn?: string;
  /** A business demerged out of the line around the rename, listed on its own: the old symbol is never that company. */
  demerged?: { symbol: string; name: string; business: string };
}

/** The name it went by: "Eletrobras". */
function renamedListingFormerName(listing: RenamedListing): string {
  return listing.formerNames[0] ?? listing.formerLabel ?? listing.from;
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
/**
 * NSE renamed Tata Motors' line, TATAMOTORS, to TMPV (Tata Motors Passenger
 * Vehicles Limited) effective 24 Oct 2025 (NSE circular CML70875; NSE's
 * symbol change list has the same row), and BSE renamed it the same day. The
 * commercial-vehicle business was demerged out of it (record date 14 Oct
 * 2025) and listed as TMCV on 12 Nov 2025; that company took the legal name
 * Tata Motors Limited, so the old code follows the line, TMPV, never the
 * name, and no name leads here.
 */
const TATA_MOTORS = { to: "TMPV", name: "Tata Motors Passenger Vehicles", formerNames: [], formerLabel: "Tata Motors", renamedOn: "2025-10-24" } as const;
const RENAMED_LISTINGS: readonly RenamedListing[] = [
  { from: "ELET3", to: "AXIA3", suffix: ".SA", exchange: "B3", name: "AXIA Energia", formerNames: ELETROBRAS },
  ...["ELET6", "AXIA6", "ELET5", "AXIA5"].map((from): RenamedListing => ({ from, to: "AXIA3", suffix: ".SA", exchange: "B3",
    name: "AXIA Energia", formerNames: ELETROBRAS, convertedOn: AXIA_PREFERRED_CONVERTED })),
  { ...TATA_MOTORS, from: "TATAMOTORS", suffix: ".NS", exchange: "NSE", shownAs: "TMPV:NSE", demerged: { symbol: "TMCV:NSE", name: "Tata Motors Limited", business: "commercial-vehicle" } },
  { ...TATA_MOTORS, from: "TATAMOTORS", suffix: ".BO", exchange: "BSE", shownAs: "TMPV:BSE", demerged: { symbol: "TMCV:BSE", name: "Tata Motors Limited", business: "commercial-vehicle" } },
];

/** "5 Jun 2026". */
function conversionDay(date: string): string {
  return formatShortDate(date, { utc: true });
}

/** `AXIA3.SA`: the new listing as `quote` takes it. */
export function renamedListingSymbol(listing: RenamedListing): string {
  return listing.shownAs ?? `${listing.to}${listing.suffix}`;
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
  if (listing.convertedOn) return `It was converted into ${named} on ${conversionDay(listing.convertedOn)}: \`gloom quote ${now}\`.`;
  return `It is now ${named}${listing.demerged ? `; ${demergedClause(listing)}` : ""}: \`gloom quote ${now}\`.`;
}

/** "its commercial-vehicle business was demerged into TMCV:NSE (Tata Motors Limited)": the company the old code is not. */
function demergedClause(listing: RenamedListing): string {
  const { business, symbol, name } = listing.demerged!;
  return `its ${business} business was demerged into ${symbol} (${name})`;
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
  if (listing.convertedOn) return `Read ${shown} as ${now}: those preferred shares were converted into ${listing.name}'s common shares on ${conversionDay(listing.convertedOn)}.`;
  // One line: the rename, and the company the old code is not.
  if (listing.renamedOn) {
    return `Read ${shown} as ${now}: ${listing.exchange} renamed ${listing.from} ${listing.to} (${listing.name}) on ${conversionDay(listing.renamedOn)}`
      + `${listing.demerged ? `; ${demergedClause(listing)}` : ""}.`;
  }
  return `Read ${shown} as ${now}: ${renamedListingFormerName(listing)} is ${listing.name} now.`;
}
