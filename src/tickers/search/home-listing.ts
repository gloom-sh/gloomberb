import { canonicalExchange } from "../../utils/exchanges";
import { companyNameExtraWords, sameCompany } from "../company-name";
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
 * an OTC or regional line), the name nearest the receipt's first. A query that names a venue (LVMH:TSX,
 * 7203.T) asked for that line, and a saved row keeps the lead.
 */
export function withHomeListingLead<T extends TickerSearchCandidate>(items: T[], query: string): T[] {
  if (isQualifiedTickerQuery(query)) return items;
  const lead = items.find((item) => item.instrumentClass !== "fund" && item.instrumentClass !== "derivative"
    && !answersOnlyByKeyword(item, query));
  if (!lead || !isListedEquity(lead)) return items;
  const name = candidateName(lead);
  const lines = items.filter((item) => item !== lead && isListedEquity(item) && sameCompany(name, candidateName(item)));
  const nearest = (candidates: T[]) => [...candidates].sort((a, b) => nameGap(name, candidateName(a)) - nameGap(name, candidateName(b))
    || items.indexOf(a) - items.indexOf(b))[0];
  const marked = lines.filter((item) => item.result?.homeListing === true);
  const home = lead.result?.homeListing === true ? undefined
    : marked.length ? nearest(marked)
    : listingDistance(lead) === 2 ? nearest(lines.filter((item) => listingDistance(item) === 0))
    : undefined;
  if (!home) return items;
  const rest = items.filter((item) => item !== home);
  const at = rest.indexOf(lead);
  return [...rest.slice(0, at), home, ...rest.slice(at)];
}
