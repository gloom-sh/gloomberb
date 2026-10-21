import { listingSuffixExchange } from "../sources/listing-symbols";
import { parsePublicTickerKey } from "../utils/exchanges";
import { listingAbroadVenue } from "../utils/sec";
import { nimCommand } from "./bank-section";
import { treasuryYieldLine, treasuryYieldTenor } from "./treasury-yields";

/**
 * Where data finer than a minute is: nowhere as bars. GIP draws 1-minute
 * bars; for a US listing TAS lists each trade (a window of the session with
 * `--from`/`--to`) and QR each quote. `history --interval`, GIP's
 * `--chartResolution 1s` and QR on a listing abroad all say this; a listing
 * known to trade abroad, which has no trades on the tape, is told only the bars.
 */
export function subMinuteDataMessage(symbol = "<ticker>", listing: "abroad" | "unknown" = listedAbroad(symbol) ? "abroad" : "unknown"): string {
  const bars = `No second or tick bars; 1-minute bars: fn GIP ${symbol}`;
  return listing === "abroad"
    ? `${bars}; trades exist for US listings only.`
    : `${bars}; for a US listing, each trade: fn TAS ${symbol} (a window: --from 10:30 --to 10:35), each quote: fn QR ${symbol}.`;
}

/**
 * Whether a listing trades abroad, by its key, its saved exchange or its
 * listing suffix (RMS.AX is the ASX): the SIP tape carries US listings only,
 * so it has nothing for one, and its bare symbol can be another company there.
 */
export function listedAbroad(key: string, exchange?: string): boolean {
  if (key === "<ticker>") return false;
  const parsed = parsePublicTickerKey(key);
  const venue = parsed.exchange || exchange || listingSuffixExchange(parsed.symbol);
  return !!venue && listingAbroadVenue(`${parsed.symbol}:${venue}`) != null;
}

/** A bar size finer than a minute, as people type one: 1s, 30s, 5sec, 500ms, tick, ticks, tick-by-tick, seconds. */
export function isSubMinuteInterval(value: string): boolean {
  return /^(\d+(\.\d+)?\s*(ms|msecs?|millis(econds?)?|s|secs?|seconds?)|\d*\s*ticks?|tick[\s-]*by[\s-]*tick|seconds?|sub[\s-]*(minute|second)s?)$/i
    .test(value.trim());
}

/**
 * Munis: the funds, where their SEC yield and tax-equivalent yield are, and
 * the curve the terminal lacks. Each fund is a listing `quote` answers
 * (checked 2026-10-19).
 */
export const MUNI_LINE = "Municipal bonds: no AAA muni curve (MMD and BVAL are licensed). Muni bond funds: MUB, VTEB, TFI (national), SUB (short-term), "
  + "CMF, VTEC (California), NYF, MUNY (New York). SEC yield, distribution yield, yield to worst and duration: gloomberb fn DVD <fund> or "
  + "gloomberb fundamentals <fund>; tax-equivalent yield and muni/Treasury ratio: add --tax-rate 40.8 (with --state-rate 13.3 --state CA for a "
  + "single-state fund).";

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
  {
    // What the terminal has for munis, and what it does not: the AAA curve every muni ratio quotes is licensed.
    terms: ["muni", "munis", "municipal", "municipals", "municipal bond", "municipal bonds", "muni bond", "muni bonds", "muni fund", "muni funds",
      "muni ETF", "muni ETFs", "municipal bond fund", "municipal bond funds", "muni yield", "muni yields", "tax-exempt", "tax exempt",
      "tax-exempt bond", "tax-exempt bonds", "tax-exempt yield", "tax-free bonds", "tax equivalent", "tax-equivalent yield", "taxable equivalent yield",
      "TEY", "muni curve", "AAA muni curve", "muni AAA curve", "MMD", "MMD curve", "BVAL", "muni/Treasury ratio", "muni Treasury ratio", "muni ratio"],
    message: MUNI_LINE,
  },
];

/**
 * A bank's deposits, uninsured share, CRE and net interest margin: no function is named for them (NIM is one slip
 * from NI, CRE the start of every credit function), the Bank section of `fundamentals` shows the first three and
 * EQS screens on NIM (Pro).
 */
const BANK_FIGURES_TOPIC = {
  topic: "Bank deposits, uninsured share and CRE / capital",
  availability: "in the Bank section of gloomberb fundamentals <ticker>",
  phrases: ["nim", "nims", "net interest margin", "net interest margins", "deposits", "deposit growth", "deposit flows",
    "deposit outflows", "deposit base", "uninsured", "cre", "commercial real estate"],
  closestLabel: "net interest margin",
  closest: [["EQS", "NIM%, Pro: gloomberb fn EQS --metric kpiNimPercent"]],
} as const;

/**
 * How to export: a flag on every command, which `export LMT`, `catalog export` and `catalog csv` look for as a
 * command or a function. One example, writing a file.
 */
function exportLine(symbol = "LMT"): string {
  return `Export: add --csv or --json to any command to print its result as CSV or JSON, e.g. gloomberb history ${symbol} --csv > ${
    symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`;
}

const EXPORT_POINTER = {
  names: ["export", "exporting", "csv", "json", "excel", "spreadsheet", "xlsx"],
  words: ["data", "to", "as", "a", "an", "the", "in", "into", "file", "files", "table", "tables", "result", "results", "output",
    "format", "save", "how", "can", "i", "my", "report", "reports", "command", "commands"],
  line: exportLine(),
  leads: true,
} as const;

/** "bank", "bank figures": beside the functions a bank's name finds (CBR), where its figures are. */
const BANK_FIGURES_POINTER = {
  names: ["bank", "banks", "banking"],
  words: ["figures", "figure", "data", "metrics", "holding", "company", "companies", "section", "kpi", "kpis", "ratios",
    "fundamentals", "stats", "statistics", "balance", "sheet"],
  line: "Bank figures (deposits, uninsured share, CRE / capital, lead bank): gloomberb fundamentals <ticker>, Bank section. "
    + "Net interest margin (Pro): gloomberb fn EQS --metric kpiNimPercent",
};

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
  /** What `closest` is called in the line, when the functions are not merely near it. */
  closestLabel?: string;
  closest: ReadonlyArray<readonly [code: string, gives: string]>;
}> = [
  BANK_FIGURES_TOPIC,
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
  {
    // "exchange reserves" alone reads as crypto's; "foreign exchange reserves" is a central bank's, so only whole.
    topic: "Crypto exchange reserves and exchange flows",
    availability: "not covered (no source for coins held on exchanges)",
    phrases: ["crypto exchange reserves", "bitcoin exchange reserves", "btc exchange reserves", "eth exchange reserves",
      "ethereum exchange reserves", "exchange inflows", "exchange outflows", "exchange netflow", "exchange netflows", "exchange net flows",
      "coins on exchanges", "bitcoin on exchanges", "btc on exchanges"],
    whole: ["exchange reserves", "exchange reserve", "exchange balances", "exchange balance", "exchange flows"],
    closest: [["CRYP", "DeFi TVL by protocol and chain: gloomberb fn CRYP --list defi; stablecoin supply: --list stablecoin"]],
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

function findTopicPointer(query: string): (typeof TOPIC_POINTERS)[number] | null {
  const asked = words(query);
  const key = lookupKey(query);
  return TOPIC_POINTERS.find(({ phrases, whole }) => phrases.some((phrase) => containsWords(asked, words(phrase)))
    || whole?.some((word) => lookupKey(word) === key)) ?? null;
}

/** The pointer for a query that asks about a topic no function covers, with the function codes it names. */
export function topicPointer(query: string): { message: string; codes: string[] } | null {
  const pointer = findTopicPointer(query);
  if (!pointer) return null;
  const closest = pointer.closest.map(([code, gives]) => `${code} (${gives})`).join(", ");
  return {
    message: `${pointer.topic}: ${pointer.availability ?? "not in the terminal yet"}; ${pointer.closestLabel ?? "closest"}: ${closest}`,
    codes: pointer.closest.map(([code]) => code),
  };
}

/**
 * Settings, reports and a function's view people look for by a word its name does not hold: the line `search`
 * and `catalog` print beside whatever else the query finds. A query asks for one when every word is a word of that
 * command and one of them names it: "light theme", "dark", "colour-blind", but not "ai theme" (THEM's basket) or
 * "dark pool"; "drip", "dividend income", but not "income statement" or "net income"; "tether", "depeg",
 * "usdc peg", but not "peg ratio". A command with `qualifiers` also needs one of them once the query says more than
 * its name: "fx forward rate", but not "forward rate".
 */
const COMMAND_POINTERS: ReadonlyArray<{
  names: readonly string[];
  words: readonly string[];
  qualifiers?: readonly string[];
  line: string;
  leads?: true;
}> = [
  BANK_FIGURES_POINTER,
  EXPORT_POINTER,
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
  {
    names: ["tether", "usdt", "usdc", "depeg", "depegs", "depegged", "depegging", "peg", "pegs", "pegged", "stablecoin", "stablecoins"],
    words: ["stable", "coin", "coins", "off", "check", "monitor", "watch", "scare", "risk", "dollar", "usd", "status", "price", "prices", "low"],
    line: "Stablecoins against their peg, off peg in bp, 24h low and high: gloomberb fn CRYP --list stablecoin",
  },
  {
    // A currency forward, not a forward rate on a yield curve, forward guidance, a forward P/E or the forward
    // inflation series: a query that says more than "forward" has to name FX.
    names: ["forward", "forwards", "fwd", "fwds"],
    words: ["rate", "rates", "implied", "hedge", "hedging", "cost", "costs", "premium", "interest", "1w", "2w", "30d", "1m", "3m",
      "6m", "1y"],
    qualifiers: ["fx", "currency", "currencies", "point", "points", "pips", "cip", "covered", "parity", "outright",
      "usd", "mxn", "eur", "gbp", "usdmxn", "eurusd", "gbpusd", "eurmxn", "peso", "dollar", "euro", "sterling"],
    line: "FX forwards implied by both currencies' short rates (covered interest parity), with forward points and the hedge cost: gloomberb fx USD/MXN --forward 30d",
  },
  {
    names: ["defi", "tvl", "tvls", "total value locked", "on-chain", "onchain", "aave", "lido", "eigenlayer", "morpho"],
    words: ["protocol", "protocols", "chain", "chains", "crypto", "data", "top", "by", "history",
      "change", "ranking", "rankings", "dashboard", "lending", "staking"],
    line: "DeFi TVL, top protocols and chains with 7D and 30D change: gloomberb fn CRYP --list defi (by chain: --by chain)",
  },
];

/** The command for a query that names a setting ("light theme") or a portfolio report ("drip"), else null. */
export function commandPointer(query: string): string | null {
  return findCommandPointer(query)?.line ?? null;
}

/**
 * Whether the query's command line answers it ahead of the functions its words find: "csv" is the flag, not
 * CDS, whose description happens to mention it.
 */
export function commandPointerLeads(query: string): boolean {
  return findCommandPointer(query)?.leads === true;
}

/**
 * The line for a command word typed as `gloomberb export LMT`: exporting is a flag every command takes, not a
 * command, so the example runs on the symbol typed. Null for any other word.
 */
export function exportCommandPointer(token: string, args: readonly string[]): string | null {
  if (findCommandPointer(token) !== EXPORT_POINTER) return null;
  const symbol = args.find((arg) => /^\^?[A-Z0-9][A-Z0-9.=-]{0,11}(?::[A-Z0-9]{1,8})?$/.test(arg) && /[A-Z]/.test(arg));
  return exportLine(symbol);
}

/** A name of several words ("on-chain") names the command when its words run together in the query. */
function findCommandPointer(query: string): (typeof COMMAND_POINTERS)[number] | null {
  const asked = words(query);
  if (asked.length === 0) return null;
  return COMMAND_POINTERS.find(({ names, words: other, qualifiers = [] }) => {
    const named = new Set(names.flatMap((name) => {
      const parts = words(name);
      return containsWords(asked, parts) ? parts : [];
    }));
    return named.size > 0
      && asked.every((word) => named.has(word) || other.includes(word) || qualifiers.includes(word))
      && (qualifiers.length === 0 || asked.every((word) => named.has(word)) || asked.some((word) => qualifiers.includes(word)));
  }) ?? null;
}

/**
 * The answer to `fn NIM JPM`, `fn DEPOSITS WFC`, `fn CRE ZION`: no function is named for a bank figure, the Bank
 * section of `fundamentals` has them, and NIM is in EQS. Null for a name that asks for anything else (`BANK` is
 * CBR's alias, so it never gets here).
 */
export function bankFigurePointer(name: string, arg: string): { message: string; details: string } | null {
  if (findTopicPointer(name) !== BANK_FIGURES_TOPIC && findCommandPointer(name) !== BANK_FIGURES_POINTER) return null;
  const symbol = /^[A-Za-z0-9.:^-]+$/.test(arg.trim()) ? arg.trim().toUpperCase() : "";
  return {
    message: `${name} is not a function: a bank's figures are in the Bank section of fundamentals.`,
    details: [
      `Deposits, uninsured share, CRE / capital and the lead bank: gloomberb fundamentals ${symbol || "<ticker>"}`,
      `Net interest margin (Pro): ${symbol ? nimCommand(symbol) : "gloomberb fn EQS --metric kpiNimPercent"}`,
    ].join("\n"),
  };
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
