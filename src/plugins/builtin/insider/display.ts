import type { InsiderReportingOwner, InsiderTransaction } from "./insider-data";

/**
 * How the Insider table reads a Form 4: names first-name-first, a short role,
 * a short transaction type, and whether a line is an open-market trade.
 */

const PERSON_SUFFIXES: Record<string, string> = {
  JR: "Jr.", SR: "Sr.", II: "II", III: "III", IV: "IV",
  MD: "M.D.", PHD: "Ph.D.", ESQ: "Esq.", CPA: "CPA",
};

/** Words that make an owner an organisation, whose name stays as filed. */
const ENTITY_WORD = /^(?:inc|incorporated|corp|corporation|co|company|cos|llc|l\.?l\.?c|lp|l\.?p|llp|lllp|ltd|limited|plc|trust|trusts|tr|ttee|trustee|trustees|fund|funds|foundation|partners|partnership|holdings?|group|capital|management|mgmt|advisors?|advisers?|investments?|investors?|ventures?|bank|bancorp|n\.?a|s\.?a|ag|gmbh|b\.?v|n\.?v|s\.?a\.?r\.?l|associates|estate|securities|financial|enterprises?|international|global|equity|opportunit(?:y|ies)|master|offshore|onshore|spv|irrevocable|revocable|living|family|charitable|endowment|pension|retirement|plan|university|college|council|board|series|ltd\.)$/i;

/**
 * Surname particles that belong with the next word ("Van Der Berg"). Short
 * words that are also surnames on their own (Le, Du, Di, Al) are left out.
 */
const SURNAME_PARTICLES = new Set(["van", "von", "de", "del", "della", "der", "den", "la", "dos", "das", "ten", "ter", "st", "st."]);

function isEntityName(name: string): boolean {
  if (/[&\d/]/.test(name)) return true;
  return name.split(/[\s,]+/).some((word) => ENTITY_WORD.test(word.replace(/[.,]+$/, "").replace(/^\(|\)$/g, "")));
}

function isInitial(word: string): boolean {
  return /^[A-Za-z]\.?$/.test(word);
}

function capitalizeWord(word: string): string {
  if (!word) return word;
  const lower = word.toLocaleLowerCase();
  // "MCDONALD" -> "McDonald"; "Mc" alone is a word of its own.
  if (/^mc[a-z]{2,}$/.test(lower)) return `Mc${lower.charAt(2).toLocaleUpperCase()}${lower.slice(3)}`;
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

/** Title-cases a name word filed in one case; one already in mixed case ("DeVore") keeps it. */
function nameWord(word: string): string {
  if (isInitial(word)) return `${word.charAt(0).toLocaleUpperCase()}.`;
  // Dotted initials ("J.P.") stay in capitals.
  if (/^(?:[A-Za-z]\.){2,}$/.test(word)) return word.toLocaleUpperCase();
  const mixed = word !== word.toLocaleUpperCase() && word !== word.toLocaleLowerCase();
  if (mixed) return word;
  return word.split(/([-'\u2019])/).map((part) => /^[-'\u2019]$/.test(part) ? part : capitalizeWord(part)).join("");
}

function formatPersonName(name: string): string {
  const words = name.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  const suffixes: string[] = [];
  const rest: string[] = [];
  words.forEach((word, index) => {
    const suffix = index > 0 ? PERSON_SUFFIXES[word.replace(/\./g, "").toUpperCase()] : undefined;
    if (suffix) suffixes.push(suffix);
    else rest.push(word);
  });
  if (rest.length < 2) return [...rest.map(nameWord), ...suffixes].join(" ");
  // SEC filings conform the reporting owner to "LAST FIRST MIDDLE".
  let surnameLength = 1;
  while (surnameLength < rest.length - 1 && SURNAME_PARTICLES.has(rest[surnameLength - 1]!.toLocaleLowerCase())) surnameLength += 1;
  // "NORA JOHNSON SUZANNE M": with a trailing initial, three given words are
  // more often a two-word surname than two middle names.
  if (rest.length - surnameLength >= 3 && isInitial(rest[rest.length - 1]!)) surnameLength += 1;
  const surname = rest.slice(0, surnameLength);
  const given = rest.slice(surnameLength);
  return [...given, ...surname].map(nameWord).concat(suffixes).join(" ");
}

/**
 * A reporting owner's name as people write it: "COOK TIMOTHY D" becomes
 * "Timothy D. Cook". Funds, companies and trusts keep the name they filed.
 * Joint filers, joined with "; ", are each formatted.
 */
export function formatInsiderName(name: string): string {
  return name.split(";").map((part) => part.trim()).filter(Boolean)
    .map((part) => isEntityName(part) ? part : formatPersonName(part))
    .join("; ");
}

interface RoleRank {
  label: string;
  rank: number;
}

const OFFICER_WORDS = /\b(?:officer|ofr|offr|off\.?)\b/i;

/** C-suite title words to their letter, for "Chief X Officer" titles. */
const CHIEF_LETTERS: Array<[RegExp, string]> = [
  [/^(?:legal)$/i, "GC"],
  [/^(?:hr|human|people)$/i, "CHRO"],
];

function chiefRole(title: string): string | null {
  const match = /\bchief\s+([a-z]+)/i.exec(title);
  if (!match || !OFFICER_WORDS.test(title.slice(match.index)) && !/\bchief\s+executive\b/i.test(title)) return null;
  const word = match[1]!;
  for (const [pattern, label] of CHIEF_LETTERS) if (pattern.test(word)) return label;
  return `C${word.charAt(0).toUpperCase()}O`;
}

const RANKS: Record<string, number> = {
  CEO: 1, President: 2, CFO: 3, COO: 4, GC: 5, Chair: 7, "Div. Pres.": 7.5, EVP: 8, SVP: 9, Controller: 10, Treasurer: 11, VP: 12, Secretary: 13, Director: 14, "10% owner": 15, Officer: 16,
};

/** A role word on its own, so "President, STC Division" reads as a unit's president and "President & CEO" does not. */
const ROLE_WORD = /\b(?:chief|c[a-z]{1,3}o|chair\w*|president|vice|evp|svp|vp|director|officer|counsel|controller|comptroller|treasurer|secretary|10\s*%|owner)\b/i;

/** Every role a title names, most senior first. */
function titleRoles(title: string): RoleRank[] {
  const roles = new Map<string, number>();
  const add = (label: string, rank = RANKS[label] ?? 6) => {
    if (!roles.has(label)) roles.set(label, rank);
  };
  // Titles join roles with "&", "and", "/", ",", ";": "Chairman & CEO", "SVP, General Counsel and Secretary".
  const parts = title.split(/\s*(?:&|\band\b|\/|,|;)\s*/i);
  for (const [index, part] of parts.entries()) {
    const text = part.trim();
    if (!text) continue;
    const acronym = /\b(C[A-Z]{1,3}O)\b/.exec(text)?.[1];
    if (acronym) add(acronym === "CLO" ? "GC" : acronym);
    else if (/\bgen(?:eral|\.)?\s+counsel\b|^GC$/i.test(text)) add("GC");
    else if (/\bprincipal\s+(executive|financial|accounting|operating)\s+officer\b/i.test(text)) {
      add(`C${/\bprincipal\s+(\w)/i.exec(text)![1]!.toUpperCase()}O`);
    }
    else if (chiefRole(text)) add(chiefRole(text)!);
    else if (/\b(?:executive\s+)?chair(?:man|woman|person)?\b/i.test(text)) add("Chair");
    else if (/\b(?:exec(?:utive|\.)?\s+vice\s+president|evp)\b/i.test(text)) add("EVP");
    else if (/\b(?:s(?:enio)?r\.?\s+vice\s+president|svp)\b/i.test(text)) add("SVP");
    else if (/\b(?:vice\s+president|vp)\b/i.test(text)) add("VP");
    else if (/\bpresident\b/i.test(text)) {
      // "Group President", "President of Americas", "President, STC Division".
      const qualified = !/^(?:co-)?president$/i.test(text) || (parts[index + 1] !== undefined && !ROLE_WORD.test(parts[index + 1]!));
      add(qualified ? "Div. Pres." : "President");
    }
    else if (/\b(?:controller|comptroller)\b/i.test(text)) add("Controller");
    else if (/\btreasurer\b/i.test(text)) add("Treasurer");
    else if (/\bsecretary\b/i.test(text)) add("Secretary");
    else if (/\bdirector\b/i.test(text)) add("Director");
    else if (/\b10\s*%/.test(text)) add("10% owner");
    else if (/^officer$/i.test(text)) add("Officer");
  }
  return [...roles].map(([label, rank]) => ({ label, rank })).sort((a, b) => a.rank - b.rank);
}

/**
 * The owner's role in a few letters for the table: "Chairman & CEO" is CEO,
 * "SVP, General Counsel and Secretary" is GC, a director who also holds 10%
 * is "10% owner". `remarks` is read only when the title points there.
 */
export function shortInsiderRole(owners: readonly Pick<InsiderReportingOwner, "title" | "director" | "tenPercentOwner">[], remarks?: string | null): string {
  const roles: RoleRank[] = [];
  let unmatched = "";
  for (const owner of owners) {
    const title = owner.title.trim();
    const former = /\b(?:former|fmr\.?|ex-)\s*/i.test(title);
    const seeRemarks = /^see\s+remarks/i.test(title);
    // A short remark is the title; a long one is usually a power of attorney naming other people.
    const source = seeRemarks ? (remarks && remarks.length <= 120 ? remarks : "") : title;
    const found = titleRoles(source).map((role) => former ? { label: `Ex-${role.label}`, rank: role.rank + 20 } : role);
    if (seeRemarks && !found.length) found.push({ label: "Officer", rank: RANKS.Officer! });
    // A director who also holds 10% is better known as the holder.
    if (owner.tenPercentOwner) found.push({ label: "10% owner", rank: RANKS.Director! - 0.5 });
    if (owner.director) found.push({ label: "Director", rank: RANKS.Director! });
    roles.push(...found.map((role) => role.label === "10% owner" ? { ...role, rank: Math.min(role.rank, RANKS.Director! - 0.5) } : role));
    if (!found.length && title) unmatched ||= title;
  }
  roles.sort((a, b) => a.rank - b.rank);
  return roles[0]?.label ?? unmatched;
}

/** Open-market purchases and sales, the trades a reader looks for first. */
export function isOpenMarketTrade(code: string | null | undefined): boolean {
  return code === "P" || code === "S";
}

const TYPE_LABELS: Record<string, string> = {
  P: "BUY", S: "SELL", A: "AWARD", D: "DISPOSE", F: "TAX", G: "GIFT",
  M: "EXERCISE", X: "EXERCISE", O: "EXERCISE", C: "CONVERT", E: "EXPIRE",
  H: "CANCEL", I: "OTHER", J: "OTHER", K: "SWAP", L: "ACQUIRE", U: "TENDER",
  W: "INHERIT", Z: "TRUST", V: "OTHER",
};

/** The transaction code as one short word: BUY, SELL, AWARD, TAX, EXERCISE, GIFT... */
export function insiderTypeLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return TYPE_LABELS[code] ?? code;
}

export type InsiderTypeTone = "buy" | "sell" | "neutral";

/** Buys read green and sales red; awards, exercises, tax, gifts and the rest stay neutral. */
export function insiderTypeTone(code: string | null | undefined): InsiderTypeTone {
  return code === "P" ? "buy" : code === "S" ? "sell" : "neutral";
}

function isCommonStock(title: string): boolean {
  return /\bcommon\b|\bordinary\s+shares?\b|^(?:shares|stock|capital stock)$/i.test(title.trim());
}

/**
 * The security in a word when a line is not plain common stock (an RSU, an
 * option, phantom units); null for common stock, which nearly every buy and
 * sale is.
 */
export function insiderSecurityTag(transaction: Pick<InsiderTransaction, "securityTitle" | "isDerivative">): string | null {
  const title = (transaction.securityTitle ?? "").trim();
  if (!title) return transaction.isDerivative ? "Derivative" : null;
  if (!transaction.isDerivative && isCommonStock(title)) return null;
  if (/restricted\s+stock\s+units?|\brsus?\b/i.test(title)) return "RSU";
  if (/performance\b.*\bunits?|\bpsus?\b|performance\s+shares?/i.test(title)) return "PSU";
  if (/phantom/i.test(title)) return "Phantom";
  if (/option|right\s+to\s+buy/i.test(title)) return "Option";
  if (/warrant/i.test(title)) return "Warrant";
  if (/preferred/i.test(title)) return "Preferred";
  if (/\bnotes?\b|debenture|\bbonds?\b/i.test(title)) return "Notes";
  if (/restricted\s+(?:stock|shares?)/i.test(title)) return "Restricted";
  if (/depositary|\bads\b|\badrs?\b/i.test(title)) return "ADS";
  if (/stock\s+units?|\bunits?\b/i.test(title)) return "Units";
  return title;
}
