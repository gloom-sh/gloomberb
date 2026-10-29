import type { InstrumentSearchResult } from "../types/instrument";

/**
 * Company names as venues spell them, compared and shortened for sentences.
 * One company's listings carry its name with different legal forms and share
 * wording ("Microsoft Corporation Common Stock", "Coca-Cola Company CDR"), so
 * they are compared by the words that say whose they are.
 */

// Words that differ between one company's listings: legal forms, and how a depositary receipt is named.
const NAME_NOISE = new Set([
  "co", "company", "corp", "corporation", "inc", "incorporated", "ltd", "limited", "llc", "lp", "plc", "sa", "ag", "nv", "se",
  "spa", "ab", "as", "asa", "oyj", "bv", "gmbh", "kgaa", "bhd", "berhad", "pcl", "the", "adr", "ads", "cedear", "cedears",
  "sponsored", "unsponsored", "cdr", "cdi", "aktiengesellschaft", "aktiebolag",
]);
// Words a venue adds to the share it lists ("Microsoft Corporation Common Stock"), never part of whose it is.
const SHARE_NOISE = new Set(["common", "ordinary", "stock", "shares"]);

/** A company's name for comparing its listings: "Kotobuki Spirits Co., Ltd." is "kotobuki spirits". */
function companyKey(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:(?:american|global) )?depositary (?:shares?|receipts?)\b/g, " ")
    .replace(/\./g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !NAME_NOISE.has(word))
    .join(" ");
}

function companyWords(name: string | null | undefined): Set<string> {
  return new Set(companyKey(name ?? "").split(" ").filter((word) => word && !SHARE_NOISE.has(word)));
}

/**
 * Whether two names are one company's, however each venue spells it: one
 * name's words are all in the other's, so "SPDR S&P 500 ETF Trust" is State
 * Street's, "Coca-Cola Company CDR" Coca-Cola's, and "CAR Group" not Avis
 * Budget Group. An empty name matches none.
 */
export function sameCompany(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = companyWords(left);
  const b = companyWords(right);
  if (a.size === 0 || b.size === 0) return false;
  const [fewer, more] = a.size <= b.size ? [a, b] : [b, a];
  return [...fewer].every((word) => more.has(word));
}

// Words that tell one class of a company's shares from another ("Berkshire Hathaway Inc. Class B"), never its business.
const SHARE_CLASS_WORD = /^(?:class|series|[a-z]|\d+)$/;

/** Whether two names differ only in how they name a class of shares, so they are one company's whatever the venue. */
function sameBusinessWords(left: Set<string>, right: Set<string>): boolean {
  const differ = [...left].filter((word) => !right.has(word)).concat([...right].filter((word) => !left.has(word)));
  return differ.every((word) => SHARE_CLASS_WORD.test(word));
}

/** A company line as `companyLines` weighs it. */
export interface CompanyLineFacts {
  name: string | null | undefined;
  /** The line's canonical venue. */
  exchange: string;
  /** A depositary receipt, whose name says whose shares it holds rather than whose it is. */
  receipt: boolean;
  /** The service marks it as its company's home line (`homeListing`). */
  home: boolean;
}

/**
 * The lines among `lines` that are `lead`'s company's own (`sameCompany`),
 * less those under a name that adds words for another business, though one
 * name's words are all in the other's: Siemens Energy AG and Siemens
 * Healthineers AG are not Siemens AG, nor Sony Financial Group Sony Group. A
 * name is another business's where a venue lists a line under it beside a
 * line under the lead's own name (both on XETRA, both in Tokyo), or where it
 * and a line under the lead's name are each marked as a home line, since a
 * company has one (Siemens Ltd. on NSE beside Siemens AG on XETRA). Receipts
 * are named for the shares they hold, so they never tell two businesses
 * apart, and nor do words that name a class of shares (Class B). A name with
 * more words on no shared venue stays the company's (Deutsche Lufthansa AG on
 * XETRA for LUFTHANSA on Budapest). `lead` is always one of them.
 */
export function companyLines<T>(lead: T, lines: readonly T[], facts: (line: T) => CompanyLineFacts): T[] {
  const own = facts(lead);
  const ownWords = companyWords(own.name);
  const ownName = (line: CompanyLineFacts) => sameBusinessWords(companyWords(line.name), ownWords);
  const candidates = lines.filter((line) => line === lead || sameCompany(own.name, facts(line).name));
  const read = candidates.map((line) => ({ line, facts: facts(line), words: companyWords(facts(line).name) }));
  const ownShares = read.filter((entry) => !entry.facts.receipt && ownName(entry.facts));
  const ownVenues = new Set(ownShares.map((entry) => entry.facts.exchange).filter(Boolean));
  const ownHome = ownShares.some((entry) => entry.facts.home);
  // A name another business goes by, once one of its share lines gives it away: all its lines are that business's.
  const others = read.filter((entry) => !entry.facts.receipt && !ownName(entry.facts)
    && ((!!entry.facts.exchange && ownVenues.has(entry.facts.exchange)) || (entry.facts.home && ownHome)));
  const otherBusiness = (words: Set<string>) => others.some((other) => sameBusinessWords(other.words, words));
  return read.filter((entry) => entry.line === lead || ownName(entry.facts) || !otherBusiness(entry.words)).map((entry) => entry.line);
}

/**
 * How many words a listing's name has beyond a company name typed for it,
 * which it must have every word of: 0 for the same name however each spells
 * its legal form ("Whirlpool Corp" for "Whirlpool Corporation"), 2 for
 * "Whirlpool of India Ltd.". Null when it lacks a word, or nothing was typed.
 */
export function companyNameExtraWords(typed: string, name: string | null | undefined): number | null {
  const wanted = companyWords(typed);
  const words = companyWords(name);
  if (wanted.size === 0 || ![...wanted].every((word) => words.has(word))) return null;
  return words.size - wanted.size;
}

/**
 * Whether a typed word is a short form of a name's word, as a list writes
 * one: its first letter and the rest in order, at least three letters
 * (`intl` for international, `hldgs` for holdings, `grp` for group).
 */
function abbreviates(short: string, word: string): boolean {
  if (short.length < 3 || short.length >= word.length || short[0] !== word[0] || !/^\p{L}+$/u.test(short)) return false;
  let at = 0;
  for (const char of word) {
    if (char === short[at]) at += 1;
    if (at === short.length) return true;
  }
  return false;
}

/**
 * `companyNameExtraWords` for a name typed with short forms, as a list or a
 * spreadsheet writes it ("philip morris intl" for Philip Morris
 * International Inc.): each typed word is one of the name's, or a short form
 * of another of its words (`abbreviates`). `extra` counts the name's words
 * left unmatched, `abbreviated` the typed words read as short forms, so an
 * exact name ranks before one only a short form reaches. Null when a typed
 * word is in the name neither way, or nothing was typed.
 */
export function companyNameMatch(typed: string, name: string | null | undefined): { extra: number; abbreviated: number } | null {
  const wanted = companyWords(typed);
  const words = companyWords(name);
  if (wanted.size === 0) return null;
  const matched = new Set<string>();
  let abbreviated = 0;
  for (const word of wanted) {
    if (words.has(word)) {
      matched.add(word);
      continue;
    }
    const long = [...words].find((candidate) => !matched.has(candidate) && !wanted.has(candidate) && abbreviates(word, candidate));
    if (!long) return null;
    matched.add(long);
    abbreviated += 1;
  }
  return { extra: words.size - matched.size, abbreviated };
}

// Words one fund's venues name it with or without: "iShares MSCI Japan Index Fund" in New York is "iShares MSCI Japan ETF" in Mexico.
const FUND_NOISE = new Set(["etf", "etfs", "fund", "funds", "index", "trust", "ucits"]);

function instrumentWords(name: string | null | undefined): Set<string> {
  return new Set([...companyWords(name)].filter((word) => !FUND_NOISE.has(word)));
}

/**
 * Whether two venues' names can be one instrument's: one company's
 * (`sameCompany`), or one fund's however a venue words it, with or without
 * "ETF", "Index Fund" or "Trust" ("Technology Select Sector SPDR Fund" in
 * Buenos Aires is State Street's ETF in New York). Two names that are not are
 * another company's or another fund's ("W.A.G Payment Solutions" is not the
 * iShares fund, nor "UBS MSCI India" iShares' India fund). An empty name
 * matches none.
 */
export function sameListedName(left: string | null | undefined, right: string | null | undefined): boolean {
  if (sameCompany(left, right)) return true;
  const a = instrumentWords(left);
  const b = instrumentWords(right);
  if (a.size === 0 || b.size === 0) return false;
  const [fewer, more] = a.size <= b.size ? [a, b] : [b, a];
  return [...fewer].every((word) => more.has(word));
}

/**
 * Whether a venue names its line a depositary receipt ("Toyota Motor
 * Corporation CEDEAR", "SS SPDR S&P 500 ETF Trust - CEDEAR"): a receipt of a
 * line elsewhere, whose short form of that line's name says little of whose it is.
 */
export function namesDepositaryReceipt(name: string | null | undefined): boolean {
  return /\b(?:cedears?|adrs?|ads|cdrs?|cdis?|depositary)\b/i.test(name ?? "");
}

/**
 * Items grouped by the company their names are (`same`, `sameCompany` unless
 * given), in the order each company first appears. Unnamed items are left out.
 */
export function groupByCompany<T>(
  items: readonly T[],
  nameOf: (item: T) => string | null | undefined,
  same: (left: string | null | undefined, right: string | null | undefined) => boolean = sameCompany,
): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    if (companyWords(nameOf(item)).size === 0) continue;
    const group = groups.find((members) => members.some((member) => same(nameOf(member), nameOf(item))));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** A company's name without its legal form, for sentences: "Avis Budget Group, Inc." is "Avis Budget Group". */
export function shortCompanyName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const legal = (word: string) => {
    const plain = word.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    // "Public Limited Company" is a legal form too, though "Public" alone can be a name.
    return NAME_NOISE.has(plain) || SHARE_NOISE.has(plain) || (plain === "public" && words.length > 2);
  };
  while (words.length > 1 && legal(words[words.length - 1]!)) words.pop();
  if (words.length > 1 && words[0]!.toLowerCase() === "the") words.shift();
  return words.join(" ").replace(/[,;]+$/, "");
}

/** "CAR Group (ASX)": a listing named by its company without the legal form, for a sentence about the company. */
export function shortListingTitle(listing: { symbol: string; exchange: string; name: string | null }): string {
  const name = listing.name?.trim() ? shortCompanyName(listing.name) : listing.symbol;
  return listing.exchange ? `${name} (${listing.exchange})` : name;
}

/** Legal forms a list abbreviates, and short words that are words where short capitals would read as initials. */
const NAME_WORDS: Readonly<Record<string, string>> = {
  INC: "Inc", CORP: "Corp", CO: "Co", LTD: "Ltd", HLDG: "Hldg", HLDGS: "Hldgs", INTL: "Intl", GRP: "Grp", ST: "St",
  OLD: "Old", NEW: "New", AIR: "Air", OIL: "Oil", GAS: "Gas", FOX: "Fox", ONE: "One", TWO: "Two", NON: "Non", NET: "Net",
  PET: "Pet", BIO: "Bio", SUN: "Sun", SIX: "Six", RED: "Red", BOX: "Box", GAP: "Gap", ELI: "Eli", DOW: "Dow", LAB: "Lab",
  MID: "Mid", SON: "Son", GEN: "Gen", HUB: "Hub", OWL: "Owl", REX: "Rex", LA: "La", LAM: "Lam", JOE: "Joe", CAL: "Cal",
  MET: "Met", GRO: "Gro", BUY: "Buy", COM: "Com", SHS: "Shs",
};
/** Words a name keeps in lower case unless it opens with one. */
const NAME_MINOR_WORDS = new Set(["AND", "OF", "THE", "FOR", "DE", "DEL"]);
/** Spellings that title case gets wrong, for the largest names; any other name reads in plain title case. */
const NAME_BRANDS: Readonly<Record<string, string>> = {
  NVIDIA: "NVIDIA", JPMORGAN: "JPMorgan", UNITEDHEALTH: "UnitedHealth", ABBVIE: "AbbVie", EXXONMOBIL: "ExxonMobil",
  PEPSICO: "PepsiCo", BLACKROCK: "BlackRock", SERVICENOW: "ServiceNow", CROWDSTRIKE: "CrowdStrike", FEDEX: "FedEx",
  PAYPAL: "PayPal", EBAY: "eBay", DOORDASH: "DoorDash", DRAFTKINGS: "DraftKings", MONGODB: "MongoDB", HUBSPOT: "HubSpot",
  GODADDY: "GoDaddy", CARMAX: "CarMax", MARKETAXESS: "MarketAxess", AUTOZONE: "AutoZone", AUTONATION: "AutoNation",
  COSTAR: "CoStar", IDACORP: "IDACORP", AECOM: "AECOM", CBRE: "CBRE", MSCI: "MSCI",
};
/** Longer than three letters, yet still capitals: a legal form, a share structure or an index. */
const NAME_INITIALISMS = new Set(["REIT", "USA", "ADR", "ADS", "VIII"]);
const NAME_DOMAINS = new Set(["COM", "NET", "ORG", "IO", "AI"]);

/** One run of letters in a name written in capitals. */
function nameWord(word: string, opening: boolean, domain: boolean): string {
  if (!/\p{L}/u.test(word)) return word;
  if (domain && NAME_DOMAINS.has(word)) return word.toLowerCase();
  const brand = NAME_BRANDS[word];
  if (brand) return brand;
  if (NAME_MINOR_WORDS.has(word)) return opening ? `${word.charAt(0)}${word.slice(1).toLowerCase()}` : word.toLowerCase();
  const plain = NAME_WORDS[word];
  if (plain) return plain;
  // Initials and tickers read as capitals: up to three letters with no word of their own, or no vowel at all.
  if (word.length <= 3 || NAME_INITIALISMS.has(word) || !/[AEIOUY]/.test(word)) return word;
  if (/^MC[A-Z]{3}/.test(word)) return `Mc${word.charAt(2)}${word.slice(3).toLowerCase()}`;
  return `${word.charAt(0)}${word.slice(1).toLowerCase()}`;
}

/**
 * A company name a source writes in capitals (an ETF's holdings file: "APPLE INC", "MERCK & CO INC") as it is
 * normally written: "Apple Inc", "Merck & Co Inc". Legal forms and short words take their usual case, initials
 * inside a name stay capitals ("GE Aerospace", "AT&T", "L3Harris"). A name with any lower case letter is written
 * the way its source means it and comes back as it is.
 */
export function companyNameCase(name: string): string {
  // A brand that opens in lower case before capitals (aTYR, iROBOT) is still a name in capitals: aTyr, iRobot.
  const brand = /^\p{Ll}(?=\p{Lu}{2})/u;
  const capitals = name.split(/\s+/).map((word) => word.replace(brand, "")).join(" ");
  if (!/\p{Lu}/u.test(name) || capitals !== capitals.toUpperCase()) return name;
  let words = 0;
  return name.replace(/\S+/g, (token) => {
    const opening = words++ === 0;
    const lead = brand.exec(token)?.[0];
    if (lead) return `${lead}${token.charAt(1)}${token.slice(2).toLowerCase()}`;
    // A separator inside a word (Coca-Cola, AT&T, Amazon.com, McDonald's) cuts it into words of its own.
    return token.split(/([-/.&,'\u2019]+)/).map((part, index, parts) => {
      if (index % 2 === 1) return part;
      const before = parts[index - 1];
      if (part === "S" && before && /['\u2019]$/.test(before)) return "s";
      // Digits split a word too: Five9, L3Harris. A run of one or two letters beside a number is an initial.
      return part.split(/(\d+)/).map((run, at) => at % 2 === 1 ? run : nameWord(run, opening && index === 0 && at === 0, before === ".")).join("");
    }).join("");
  });
}

/** Letters and digits only, in capitals: "JP Morgan" and "JPMorgan" are JPMORGAN. */
export function runTogether(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Whether the service marked the row with the name as typed: the company it means by it. */
export function namedByService(typed: string, result: Pick<InstrumentSearchResult, "searchAliases">): boolean {
  const wanted = runTogether(typed);
  return !!wanted && Array.isArray(result.searchAliases)
    && result.searchAliases.some((alias) => typeof alias === "string" && runTogether(alias) === wanted);
}
