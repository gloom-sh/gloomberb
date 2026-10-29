import { canonicalExchange, isUsListingExchange } from "../../utils/exchanges";
import { companyLines, companyNameExtraWords, namedByService, type CompanyLineFacts } from "../company-name";
import { answersOnlyByKeyword, isQualifiedTickerQuery } from "./ranking";
import type { TickerSearchCandidate } from "./types";

/** Venues that only quote shares listed elsewhere: the OTC tiers, Frankfurt's open market and Germany's regional exchanges. */
const SECONDARY_VENUES = new Set(["OTC", "PNK", "OTCQX", "OTCQB", "FWB2", "MUNICH", "XMUN", "XSTU", "XDUS", "XBER", "XHAM", "HANOVER", "XHAN"]);
const RECEIPT_TYPE = /depositary|^(?:ADR|ADS|GDR|CDR|BDR)$/i;

/** The venue a row lists on; broker routing (SMART) names its primary exchange. */
export function candidateExchange(candidate: TickerSearchCandidate): string {
  return canonicalExchange(candidate.result?.exchange === "SMART"
    ? candidate.result.primaryExchange
    : candidate.result?.exchange || candidate.result?.primaryExchange || candidate.ticker?.metadata.exchange || candidate.right);
}

/**
 * How far a listing is from being its company's own line: 0 a plain one, 1 a
 * line that only quotes shares listed elsewhere (a regional venue, OTC, a
 * Milan 4MSFT or London 0XXX code), 2 a depositary receipt.
 */
export function listingDistance(candidate: TickerSearchCandidate): 0 | 1 | 2 {
  return lineDistance(candidate.instrumentType ?? "", candidateExchange(candidate), candidate.symbol);
}

/** `listingDistance` of a line by its type, its canonical venue and its symbol. */
export function lineDistance(type: string, exchange: string, symbol: string): 0 | 1 | 2 {
  if (RECEIPT_TYPE.test(type)) return 2;
  return SECONDARY_VENUES.has(exchange) || /\d/.test(symbol) && /[A-Za-z]/.test(symbol) ? 1 : 0;
}

/** How the primary-listing choice weighs one of a company's lines. */
export interface WeighedCompanyLine {
  /** `listingDistance`: 0 its own line, 1 a line quoting shares listed elsewhere, 2 a receipt. */
  distance: number;
  /** The search score the service gives the listings people look up most; null when it gives none. */
  score: number | null;
}

/**
 * The line a company's search lists as its primary listing instead of `lead`,
 * the line search put first, often the one-off cross-listing whose short name
 * matched the query (LUFTHANSA on Budapest): its lines go by how far each is
 * from being its own line, then by the search score. The lead gives way only
 * to a closer line, or to one searched at least twice as often, or any scored
 * line when it has no score. With `named` (the service marked the lead with
 * the name as typed) no score outweighs the mark: only a closer line does.
 * `lines` holds the lead. `search` and a company's name typed for a listing
 * (`findListingOfCompanyName`) choose by this one rule, so both open the same
 * listing.
 */
export function primaryCompanyLine<T>(
  lead: T,
  lines: readonly T[],
  weigh: (line: T) => WeighedCompanyLine,
  options: { named?: boolean } = {},
): T {
  const order = (line: T) => lines.indexOf(line);
  const [home] = [...lines].sort((a, b) => weigh(a).distance - weigh(b).distance
    || (weigh(b).score ?? -1) - (weigh(a).score ?? -1) || order(a) - order(b));
  if (!home || home === lead) return lead;
  const [best, first] = [weigh(home), weigh(lead)];
  const closer = best.distance < first.distance;
  const moreSearched = !options.named && best.distance === first.distance && best.score != null
    && (first.score == null || best.score >= first.score * 2);
  return closer || moreSearched ? home : lead;
}

/** A row as `companyLines` weighs it. */
function lineFacts(candidate: TickerSearchCandidate): CompanyLineFacts {
  return {
    name: candidateName(candidate),
    exchange: candidateExchange(candidate),
    receipt: listingDistance(candidate) === 2,
    home: candidate.result?.homeListing === true,
  };
}

/** The rows of `lead`'s company among `items` (`companyLines`): never a line of another business its name is in (Siemens Energy for Siemens). */
function companyRows<T extends TickerSearchCandidate>(lead: T, items: readonly T[]): T[] {
  return companyLines(lead, items.filter((item) => item === lead || isListedEquity(item)), lineFacts);
}

/** `primaryCompanyLine` among `items` of `start`'s company, for the command bar's rows. */
function primaryLineOf<T extends TickerSearchCandidate>(start: T, items: readonly T[], query: string): T {
  const name = candidateName(start);
  const named = !!start.result && namedByService(query, start.result);
  const lines = companyRows(start, items).filter((item) => item === start
    || !named || companyNameExtraWords(candidateName(item), name) != null);
  return primaryCompanyLine(start, lines, (item) => ({
    distance: listingDistance(item), score: item.result?.popularity ?? item.popularity ?? null,
  }), { named });
}

function candidateName(candidate: TickerSearchCandidate): string {
  return candidate.result?.name || candidate.detail.split(" | ")[0] || "";
}

/** How many words two names of one company differ by: Sony Group Corp. is nearer Sony Group ADR than Sony Financial Group. */
function nameGap(left: string, right: string): number {
  return companyNameExtraWords(left, right) ?? companyNameExtraWords(right, left) ?? Number.MAX_SAFE_INTEGER;
}

function isListedEquity(candidate: TickerSearchCandidate): boolean {
  return candidate.kind === "search" && !candidate.saved
    && (candidate.instrumentClass === "equity" || candidate.instrumentClass === "other");
}

/**
 * The company search lists first is listed under its home line, its common
 * stock on its home exchange, ahead of its depositary receipts: "Sony" and
 * "LVMH" match receipts' tickers (SONY in New York, LVMH in Toronto), and a
 * provider can file Toyota's NYSE receipt before Tokyo's 7203. The line the
 * service marks as the company's home (`homeListing`) takes the lead from
 * the company's first row. Without that mark, a receipt in the lead gives
 * way to the company's own shares on an exchange (`listingDistance` 0, not
 * an OTC or regional line), the name nearest the receipt's first. Then the
 * line `search` calls the company's primary listing (`primaryCompanyLine`)
 * takes the lead, so a name opens what `search` lists first: LHA on XETRA
 * for "lufthansa", not LUFTHANSA on Budapest. A company's lines are never
 * another business's its name is in (`companyLines`: Siemens Energy AG for
 * Siemens AG). The row the service marks with the word as typed is the
 * company the word means, ahead of a line abroad whose symbol is the word:
 * "siemens" is SIE on XETRA, not SIEMENS on NSE (Siemens Ltd.); a US line
 * keeps its ticker. A query that names a venue (LVMH:TSX, 7203.T) asked for
 * that line, and a saved row keeps the lead.
 */
export function withHomeListingLead<T extends TickerSearchCandidate>(items: T[], query: string): T[] {
  if (isQualifiedTickerQuery(query)) return items;
  const lead = items.find((item) => item.instrumentClass !== "fund" && item.instrumentClass !== "derivative"
    && !answersOnlyByKeyword(item, query));
  if (!lead || !isListedEquity(lead)) return items;
  const typedSymbol = lead.symbol.toUpperCase() === query.trim().toUpperCase();
  const meant = typedSymbol && !isUsListingExchange(candidateExchange(lead)) && !(lead.result && namedByService(query, lead.result))
    // A company's shares under another symbol: an index the code also names (SPX) or the word's own line elsewhere (SAP) is not it.
    ? items.find((item) => item !== lead && isListedEquity(item) && item.instrumentClass === "equity" && !!item.result
      && item.symbol.toUpperCase() !== lead.symbol.toUpperCase() && namedByService(query, item.result))
    : undefined;
  if (meant) return moveAhead(items, meant, lead);
  const name = candidateName(lead);
  const lines = companyRows(lead, items).filter((item) => item !== lead);
  const nearest = (candidates: T[]) => [...candidates].sort((a, b) => nameGap(name, candidateName(a)) - nameGap(name, candidateName(b))
    || items.indexOf(a) - items.indexOf(b))[0];
  const marked = lines.filter((item) => item.result?.homeListing === true);
  const own = listingDistance(lead) === 2 ? nearest(lines.filter((item) => listingDistance(item) === 0)) : undefined;
  const home = lead.result?.homeListing === true ? undefined
    : marked.length ? nearest(marked)
    // A listing searched by its own symbol is that listing, as `search` keeps it.
    : typedSymbol ? own
    : primaryLineOf(own ?? lead, [lead, ...lines], query);
  if (!home || home === lead) return items;
  return moveAhead(items, home, lead);
}

/** `items` with `home` moved just ahead of `lead`. */
function moveAhead<T>(items: readonly T[], home: T, lead: T): T[] {
  const rest = items.filter((item) => item !== home);
  const at = rest.indexOf(lead);
  return [...rest.slice(0, at), home, ...rest.slice(at)];
}
