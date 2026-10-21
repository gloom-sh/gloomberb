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
  "sponsored", "unsponsored", "cdr", "cdi",
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

/** Items grouped by the company their names are, in the order each company first appears. Unnamed items are left out. */
export function groupByCompany<T>(items: readonly T[], nameOf: (item: T) => string | null | undefined): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    if (companyWords(nameOf(item)).size === 0) continue;
    const group = groups.find((members) => members.some((member) => sameCompany(nameOf(member), nameOf(item))));
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
