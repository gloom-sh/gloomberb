// An option contract as people type it for an IV spike alert (`SPY 680C 11/19`,
// `SPY241119C680`, `SPY Nov 19 680 call`), read against the listed chain into
// the one OCC contract it names. Anything that names none, or more than one,
// is refused with the OCC form and a contract that is listed.
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { expiryIsoDate, isLiveOptionExpiry } from "../../../utils/option-expiry";
import { optionContractName } from "../../../utils/options";

/** One contract as typed: its root, expiry (the year left out when it was), side and strike. */
export interface LooseOptionContract {
  root: string;
  /** Null when the year was not typed (`11/19`): the next listed expiry on that day. */
  year: number | null;
  month: number;
  day: number;
  side: "C" | "P";
  strike: number;
}

/** An OCC contract as a rule keeps it: root, YYMMDD, C or P, the strike times 1,000 in 8 digits. */
export const OCC_CONTRACT = /^(?:O:)?[A-Z.]{1,6}\d{6}[CP]\d{8}$/i;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const NUMBER = String.raw`\$?(\d+(?:\.\d+)?)`;
const SIDE_WORDS: Readonly<Record<string, "C" | "P">> = { C: "C", CALL: "C", CALLS: "C", P: "P", PUT: "P", PUTS: "P" };

const two = (value: number) => String(value).padStart(2, "0");

/** The OCC symbol of a contract: `SPY261119C00680000`. */
function occContractSymbol(root: string, year: number, month: number, day: number, side: "C" | "P", strike: number): string {
  return `${root}${two(year % 100)}${two(month)}${two(day)}${side}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

function validDay(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function monthOf(token: string): number | null {
  const index = MONTHS.findIndex((month) => token.startsWith(month) && /^[A-Z]+$/.test(token) && token.length <= 9);
  return index < 0 ? null : index + 1;
}

const fullYear = (text: string) => text.length === 4 ? Number(text) : 2000 + Number(text.replace(/^'/, ""));

/**
 * A contract typed loosely: an OCC symbol whose strike is not padded
 * (`SPY241119C680`), or the root, an expiry (`11/19`, `11/19/26`,
 * `2026-11-19`, `261119`, `Nov 19 '26`, `19 Nov`) and the strike with its side
 * (`680C`, `C680`, `680 call`) in any order. Null for anything else.
 */
export function parseLooseOptionContract(text: string): LooseOptionContract | null {
  const typed = text.trim().toUpperCase().replace(/^O:/, "").replace(/,/g, "");
  const compact = new RegExp(String.raw`^([A-Z][A-Z.]{0,5})\s*(\d{2})(\d{2})(\d{2})\s*([CP])\s*${NUMBER}$`).exec(typed);
  if (compact) {
    const [, root, yy, mm, dd, side, strike] = compact;
    const year = 2000 + Number(yy);
    // Eight digits with no point are OCC's own strike, in thousandths.
    const value = /^\d{8}$/.test(strike!) ? Number(strike) / 1000 : Number(strike);
    return validDay(year, Number(mm), Number(dd)) && value > 0
      ? { root: root!, year, month: Number(mm), day: Number(dd), side: side as "C" | "P", strike: value } : null;
  }
  const [root = "", ...tokens] = typed.split(/\s+/);
  if (!/^[A-Z][A-Z.]{0,5}$/.test(root) || tokens.length === 0) return null;
  let date: { year: number | null; month: number; day: number } | null = null;
  let side: "C" | "P" | null = null;
  let strike: number | null = null;
  const rest: string[] = [];
  for (const token of tokens) {
    const withSide = new RegExp(`^${NUMBER}([CP])$`).exec(token) ?? new RegExp(`^([CP])${NUMBER}$`).exec(token);
    const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(token);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
    const yymmdd = /^(\d{2})(\d{2})(\d{2})$/.exec(token);
    if (withSide && strike == null) {
      const [first, second] = [withSide[1]!, withSide[2]!];
      side = (/^[CP]$/.test(first) ? first : second) as "C" | "P";
      strike = Number(/^[CP]$/.test(first) ? second : first);
    } else if (slash && !date) date = { month: Number(slash[1]), day: Number(slash[2]), year: slash[3] ? fullYear(slash[3]) : null };
    else if (iso && !date) date = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    else if (yymmdd && !date) date = { year: 2000 + Number(yymmdd[1]), month: Number(yymmdd[2]), day: Number(yymmdd[3]) };
    else rest.push(token);
  }
  // A month by name takes the day beside it (`Nov 19`, `19 Nov`), and a year after them (`'26`, `2026`).
  const named = rest.findIndex((token) => monthOf(token) != null);
  if (named >= 0 && !date) {
    const month = monthOf(rest[named]!)!;
    const dayAt = /^\d{1,2}$/.test(rest[named + 1] ?? "") ? named + 1 : /^\d{1,2}$/.test(rest[named - 1] ?? "") ? named - 1 : -1;
    if (dayAt < 0) return null;
    const after = rest[Math.max(named, dayAt) + 1] ?? "";
    // `'26` and `2026` are years; a bare `26` only while a strike is typed beside it, else it is the strike.
    const strikeLater = rest.slice(Math.max(named, dayAt) + 2).some((token) => new RegExp(`^${NUMBER}$`).test(token));
    const yearToken = /^'\d{2}$|^20\d{2}$/.test(after) || (/^\d{2}$/.test(after) && (strike != null || strikeLater)) ? after : null;
    date = { month, day: Number(rest[dayAt]), year: yearToken ? fullYear(yearToken) : null };
    rest.splice(Math.min(named, dayAt), yearToken ? 3 : 2);
  }
  for (const token of rest) {
    if (SIDE_WORDS[token] && !side) side = SIDE_WORDS[token]!;
    else if (new RegExp(`^${NUMBER}$`).test(token) && strike == null) strike = Number(token.replace(/^\$/, ""));
    else return null;
  }
  if (!date || !side || strike == null || !(strike > 0)) return null;
  if (date.month < 1 || date.month > 12 || !validDay(date.year ?? 2028, date.month, date.day)) return null;
  return { root, ...date, side, strike };
}

/** How a contract was typed, in words: `SPY Nov 19 $680 Call`. */
function describe(contract: LooseOptionContract): string {
  return `${contract.root} ${MONTHS[contract.month - 1]![0]}${MONTHS[contract.month - 1]!.slice(1).toLowerCase()} ${contract.day}`
    + `${contract.year != null ? ` '${two(contract.year % 100)}` : ""} $${contract.strike} ${contract.side === "C" ? "Call" : "Put"}`;
}

/** The next `month`/`day` from `now` (this year's, or next year's once it has passed), as a chain stamps an expiry. */
function nextDay(month: number, day: number, now: number): number {
  const year = new Date(now).getUTCFullYear();
  const thisYear = Date.UTC(year, month - 1, day);
  return (thisYear >= Date.UTC(year, new Date(now).getUTCMonth(), new Date(now).getUTCDate()) ? thisYear : Date.UTC(year + 1, month - 1, day)) / 1000;
}

/** What the chain's listing is read through: the expiries with no argument, one expiry's contracts with its stamp. */
export type ChainReader = (expiration?: number) => Promise<Pick<OptionsChain, "expirationDates" | "calls" | "puts">>;

/** The OCC form, said where a contract does not read or names none listed. */
export function occFormText(example: string): string {
  return `An IV spike follows one OCC contract: the root, the expiry as YYMMDD, C or P, and the strike times 1,000 in 8 digits, such as ${example}`;
}

/** A contract's OCC symbol as listed (SPXW for an SPX weekly), else as built from what it is. */
function listedSymbol(contract: OptionContract, built: string): string {
  const symbol = contract.contractSymbol?.trim().toUpperCase().replace(/^O:/, "") ?? "";
  return OCC_CONTRACT.test(symbol) ? symbol : built;
}

/**
 * The one listed contract a loosely typed one names, with the note saying what
 * it was read as. A year left out is the next listed expiry on that day. A
 * contract past its expiry is returned as typed, for the rule to refuse it as
 * expired; one that names no listed contract throws, with the OCC form and a
 * listed contract to copy, and one that names several (SPX and SPXW on one
 * expiry) throws naming each, never picking one.
 */
export async function resolveLooseOptionContract(
  typed: string,
  contract: LooseOptionContract,
  readChain: ChainReader,
  now: number,
): Promise<{ contract: string; readAs: string | null }> {
  const { root, month, day, side, strike } = contract;
  if (contract.year != null) {
    const stamp = Date.UTC(contract.year, month - 1, day) / 1000;
    // Expired: the rule refuses it, naming the expiry and the underlying's live ones.
    if (!isLiveOptionExpiry(stamp, now)) return { contract: occContractSymbol(root, contract.year, month, day, side, strike), readAs: null };
  }
  const listing = await readChain();
  const live = [...new Set(listing.expirationDates)].filter((stamp) => isLiveOptionExpiry(stamp, now)).sort((a, b) => a - b);
  const sameDay = (stamp: number) => {
    const date = new Date(stamp * 1000);
    return date.getUTCMonth() + 1 === month && date.getUTCDate() === day && (contract.year == null || date.getUTCFullYear() === contract.year);
  };
  const expiry = live.find(sameDay);
  const contracts = expiry == null ? [] : (await readChain(expiry))[side === "C" ? "calls" : "puts"];
  // Every contract the day lists at that strike and side, once each: two roots can list one (SPX and SPXW).
  const expiryDate = expiry == null ? null : new Date(expiry * 1000);
  const matches = expiryDate == null ? [] : [...new Set(contracts.filter((entry) => Math.abs(entry.strike - strike) < 1e-6)
    .map((entry) => listedSymbol(entry, occContractSymbol(root, expiryDate.getUTCFullYear(), month, day, side, strike))))];
  if (matches.length > 1) {
    throw new Error(`"${typed.trim()}" (${describe(contract)}) matches ${matches.length} listed contracts: ${matches.join(", ")}. `
      + "An IV spike follows one: name it by its OCC symbol.");
  }
  const [symbol] = matches;
  if (symbol) return { contract: symbol, readAs: `Read "${typed.trim()}" as ${symbol} (${optionContractName(symbol) ?? symbol}).` };
  // A listed contract to copy: the typed strike's nearest on the typed day's expiry, else on the live expiry nearest that day.
  const typedDay = contract.year != null ? Date.UTC(contract.year, month - 1, day) / 1000 : nextDay(month, day, now);
  const exampleExpiry = expiry ?? live.reduce<number | undefined>((best, stamp) =>
    best == null || Math.abs(stamp - typedDay) < Math.abs(best - typedDay) ? stamp : best, undefined);
  const exampleChain = exampleExpiry == null ? [] : expiry != null ? contracts
    : (await readChain(exampleExpiry))[side === "C" ? "calls" : "puts"];
  const nearest = exampleChain.reduce<OptionContract | null>((best, entry) => !best || Math.abs(entry.strike - strike) < Math.abs(best.strike - strike) ? entry : best, null);
  const exampleDate = exampleExpiry == null ? null : new Date(exampleExpiry * 1000);
  const example = nearest && exampleDate
    ? listedSymbol(nearest, occContractSymbol(root, exampleDate.getUTCFullYear(), exampleDate.getUTCMonth() + 1, exampleDate.getUTCDate(), side, nearest.strike))
    : occContractExample(now);
  const why = expiry == null
    ? `${root} lists no live expiry on ${MONTHS[month - 1]![0]}${MONTHS[month - 1]!.slice(1).toLowerCase()} ${day}${contract.year != null ? ` ${contract.year}` : ""}`
    : `${root}'s ${expiryIsoDate(expiry)} expiry lists no $${strike} ${side === "C" ? "call" : "put"}`;
  throw new Error(`"${typed.trim()}" (${describe(contract)}) names no listed contract: ${why}. ${occFormText(example)}; gloom options ${root} lists them.`);
}

/**
 * An OCC contract that has not expired, for an example where no chain gives
 * one: an AAPL call on the monthly expiry (the third Friday) two months from `now`.
 */
export function occContractExample(now: number | Date = Date.now()): string {
  const at = new Date(now);
  const month = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 2, 1));
  const thirdFriday = 1 + ((5 - month.getUTCDay() + 7) % 7) + 14;
  return occContractSymbol("AAPL", month.getUTCFullYear(), month.getUTCMonth() + 1, thirdFriday, "C", 300);
}
