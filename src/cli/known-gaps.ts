import { treasuryYieldLine, treasuryYieldTenor } from "./treasury-yields";

/**
 * Where data finer than a minute is: nowhere as bars. GIP draws 1-minute
 * bars, and QR lists each trade of a US listing. `history --interval`, GIP's
 * `--chartResolution 1s` and QR on a listing abroad all say this.
 */
export function subMinuteDataMessage(symbol = "<ticker>"): string {
  return `No second or tick bars; 1-minute bars: fn GIP ${symbol}; trades exist for US listings only.`;
}

/** A bar size finer than a minute, as people type one: 1s, 30s, 5sec, 500ms, tick, ticks, tick-by-tick, seconds. */
export function isSubMinuteInterval(value: string): boolean {
  return /^(\d+(\.\d+)?\s*(ms|msecs?|millis(econds?)?|s|secs?|seconds?)|\d*\s*ticks?|tick[\s-]*by[\s-]*tick|seconds?|sub[\s-]*(minute|second)s?)$/i
    .test(value.trim());
}

/**
 * Data people look for under a name search cannot find: where the app has it,
 * or, while no source carries it, the nearest thing the app does have, with
 * the traded proxies either way. `search` and `catalog` answer a query that
 * names one with this line instead of pointing at each other. One entry per
 * subject; every proxy named is a listing `gloomberb quote` answers (checked
 * 2026-10-11: CO2:LSE is the physical EUA ETC, while a bare CO2 is a Brent
 * future; BDRY, SBLK, GNK and DSX on 2026-10-17), a function `fn` runs, or a
 * command that answers (`news "dry bulk"`).
 *
 * `tickers` are terms that are also a real ticker (BDI is Black Diamond Group):
 * a query that is only that word still gets the line, but `quote` adds it only
 * to the exchange question or the failure of the bare symbol, never to a quote.
 */
const KNOWN_GAPS: ReadonlyArray<{ terms: readonly string[]; tickers?: readonly string[]; message: string }> = [
  {
    terms: ["EUA", "EUAs", "EU ETS", "EU allowance", "EU allowances", "EU carbon", "carbon", "carbon allowance", "carbon allowances",
      "carbon price", "carbon prices", "carbon credits", "emission allowances", "emissions allowances"],
    message: "EU carbon (EUA): the auction price is in EPWR, chart CAP:carbon:eua. Traded proxies: CO2:LSE, KRBN.",
  },
  {
    terms: ["EU gas storage", "European gas storage", "Europe gas storage", "EU gas inventories", "European gas inventories",
      "AGSI", "AGSI+", "GIE AGSI", "gas storage Europe"],
    message: "European gas storage: EPWR GAS, or EPWR GAS DE for one country; chart CAP:gas-storage:eu. US storage is NGS.",
  },
  {
    terms: ["tick", "ticks", "tick data", "tick bars", "tick by tick", "second", "seconds", "second bars", "1s", "1 second",
      "1 second bars", "sub-minute", "sub minute bars", "subsecond"],
    message: subMinuteDataMessage(),
  },
  {
    terms: ["Baltic", "Baltic Dry", "Baltic Dry Index", "Baltic Exchange", "Baltic index", "Baltic indices", "BDI", "BDIY", "freight",
      "freight rate", "freight rates", "freight index", "freight futures", "freight forward", "freight forwards", "freight forward agreement",
      "freight forward agreements", "FFA", "FFAs", "capesize", "panamax", "supramax", "charter rate", "charter rates", "dry bulk",
      "dry bulk rates", "dry bulk freight"],
    tickers: ["BDI"],
    message: "Baltic indices (BDI, Capesize, Panamax, Supramax) and freight forwards (FFA) are not covered. Traded proxies: BDRY (freight futures ETF), "
      + "SBLK, GNK, DSX (dry-bulk shipowners); chokepoint transits: fn CHOKE; news \"dry bulk\".",
  },
];

/**
 * Topics a query asks the terminal about that no function covers, with the nearest functions that do part of it.
 * A query naming one (as a phrase, so "us defense budget 2027" does too) is answered with the pointer instead of
 * the loose matches its words would find: "budget" is OSA's hedge budget, not a defense one. One line per topic:
 * its name, the words that ask for it, and the function codes closest to it with what each gives. Drop a topic
 * once a function covers it.
 */
const TOPIC_POINTERS: ReadonlyArray<{
  topic: string;
  /** What is true of it, when "not in the terminal yet" is not: no source carries it. */
  availability?: string;
  phrases: readonly string[];
  /** Words that ask for the topic only as the whole query: "utilization" alone, but "capacity utilization" is another thing. */
  whole?: readonly string[];
  closest: ReadonlyArray<readonly [code: string, gives: string]>;
}> = [
  {
    topic: "defense budget",
    phrases: ["defense budget", "defence budget", "defense spending", "defence spending", "dod", "department of defense",
      "military budget", "military spending", "pentagon budget", "pentagon spending"],
    closest: [["AWARDS", "government contract awards by company"], ["THEM", "defense and aerospace theme: fn THEM defense"]],
  },
  {
    // SI's own limitations say the same, so a search for a borrow fee does not read SI as a source of one.
    topic: "borrow fee, utilization and locate",
    availability: "not available (no securities-lending data)",
    phrases: ["borrow fee", "borrow fees", "borrow rate", "borrow rates", "borrow cost", "borrow costs", "cost to borrow", "short borrow",
      "stock borrow", "borrow availability", "borrow utilization", "borrow utilisation", "shares to borrow", "hard to borrow",
      "easy to borrow", "securities lending", "stock loan", "stock lending", "locate fee", "short locate"],
    whole: ["borrow", "borrowing", "utilization", "utilisation", "locate", "locates", "htb", "lendable shares"],
    closest: [["SI", "FINRA short interest and days to cover"], ["SIW", "crowded shorts across your names"], ["SIV", "daily short volume"]],
  },
];

/** The words of a text, lower case: `DoD-budget` and `dod budget` read alike. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whether `phrase` is a run of consecutive words in `query`. */
function containsWords(query: readonly string[], phrase: readonly string[]): boolean {
  for (let at = 0; at + phrase.length <= query.length; at += 1) {
    if (phrase.every((word, index) => query[at + index] === word)) return true;
  }
  return false;
}

/** The pointer for a query that asks about a topic no function covers, with the function codes it names. */
export function topicPointer(query: string): { message: string; codes: string[] } | null {
  const asked = words(query);
  const key = lookupKey(query);
  const pointer = TOPIC_POINTERS.find(({ phrases, whole }) => phrases.some((phrase) => containsWords(asked, words(phrase)))
    || whole?.some((word) => lookupKey(word) === key));
  if (!pointer) return null;
  const closest = pointer.closest.map(([code, gives]) => `${code} (${gives})`).join(", ");
  return {
    message: `${pointer.topic}: ${pointer.availability ?? "not in the terminal yet"}; closest: ${closest}`,
    codes: pointer.closest.map(([code]) => code),
  };
}

/**
 * Settings and reports people look for by name that are a command, not a function or a ticker: the line `search`
 * and `catalog` print beside whatever else the query finds. A query asks for one when every word is a word of that
 * command and one of them names it: "light theme", "dark", "colour-blind", but not "ai theme" (THEM's basket) or
 * "dark pool"; "drip", "dividend income", but not "income statement" or "net income".
 */
const COMMAND_POINTERS: ReadonlyArray<{ names: readonly string[]; words: readonly string[]; line: string }> = [
  {
    names: ["theme", "themes", "light", "dark", "colorblind", "colourblind", "blind"],
    words: ["mode", "color", "colour", "colors", "colours", "high", "contrast", "change", "switch", "set", "setting", "settings"],
    line: "Themes: gloomberb config themes",
  },
  {
    names: ["drip", "drips", "reinvest", "reinvested", "reinvesting", "reinvestment", "income"],
    words: ["dividend", "dividends", "portfolio", "my", "annual", "yearly", "passive", "projection", "project", "projected",
      "plan", "planner", "calculator", "forecast", "yield", "growth"],
    line: "Portfolio income, yield and DRIP projection: gloomberb portfolio show <name> --drip",
  },
];

/** The command for a query that names a setting ("light theme") or a portfolio report ("drip"), else null. */
export function commandPointer(query: string): string | null {
  const asked = words(query);
  if (asked.length === 0) return null;
  return COMMAND_POINTERS.find(({ names, words: other }) => asked.some((word) => names.includes(word))
    && asked.every((word) => names.includes(word) || other.includes(word)))?.line ?? null;
}

/** Letters and digits only, lower case: `EU-ETS`, `eu ets` and `EUETS` are one lookup. */
function lookupKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The line for a symbol typed on its own that names a known subject as well as a ticker (BDI, the Baltic Dry Index
 * and Black Diamond Group), for the answer that has no quote to show it; null for any other symbol.
 */
export function knownGapForTicker(symbol: string): string | null {
  const key = lookupKey(symbol);
  return key ? KNOWN_GAPS.find((gap) => gap.tickers?.some((ticker) => lookupKey(ticker) === key))?.message ?? null : null;
}

/**
 * The line for a query that names a known subject as a whole ("carbon allowances", "EUA"), a Treasury yield
 * typed as a ticker (US10Y), or a topic with no function ("defense budget"), else null.
 */
export function knownGapMessage(query: string): string | null {
  const key = lookupKey(query);
  if (!key) return null;
  const tenor = treasuryYieldTenor(query);
  return KNOWN_GAPS.find((gap) => gap.terms.some((term) => lookupKey(term) === key))?.message
    ?? (tenor ? treasuryYieldLine(tenor) : null)
    ?? topicPointer(query)?.message ?? null;
}
