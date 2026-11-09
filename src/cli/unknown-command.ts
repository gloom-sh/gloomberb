import { fxVolatilityProxyFund } from "../market-data/options-alternatives";
import { currencyPairSpelling, dollarPairListing } from "../utils/currency-pair";
import { currenciesNamed, currencyCodeTyped } from "../utils/currency-names";
import { bankFigurePointer, exportCommandPointer } from "./known-gaps";

/** A function the catalog finds for a word typed as a command (`comps`, `peers`). */
export interface CatalogCommandHit {
  code: string;
  label: string;
  /** What the function takes after its code: `ticker`, `tickers`, `free-text`, `none`... */
  argKind: string | null;
  argPlaceholder: string | null;
  /** It has a `--peers` switch that adds a symbol's competitors (RV). */
  peers: boolean;
  /** It answers this listing with a refusal before any request (OVDV for EURUSD=X): a command with it would fail. */
  refusesSymbol?: (key: string) => boolean;
  /** Its ticker argument takes a currency pair (HP, HVT, GP): a currency typed after it is written as its pair. */
  takesFx?: boolean;
}

/** An FX pair as a word reads: its listing for `quote` (EURUSD=X), as `fx` takes it (EUR/USD), and its code (EURUSD). */
export interface CurrencyWordPair {
  listing: string;
  pair: string;
  code: string;
}

/**
 * The pair a word typed in place of a command or a ticker reads as: a pair
 * in any spelling and case (`eurusd`, `EUR/USD`, `eurusd=x`), or one
 * currency, by its code (`eur`, `JPY`) or a name only it has (`euro`, `yen`),
 * as its pair against the dollar the way markets quote it (EUR/USD, USD/JPY).
 * Null for anything else, and for the dollar on its own, which has no pair
 * of its own.
 */
export function currencyWordPair(word: string): CurrencyWordPair | null {
  const typed = word.trim();
  if (!typed || /\s/.test(typed)) return null;
  const spelled = currencyPairSpelling(typed.toUpperCase());
  const named = currenciesNamed(typed);
  const code = spelled ? null : currencyCodeTyped(typed) ?? (named.length === 1 ? named[0]!.code : null);
  const listing = spelled?.symbol ?? (code && code !== "USD" ? dollarPairListing(code) : null);
  const halves = listing ? /^([A-Z]{3})([A-Z]{3})=X$/.exec(listing) : null;
  return halves ? { listing: listing!, pair: `${halves[1]}/${halves[2]}`, code: `${halves[1]}${halves[2]}` } : null;
}

/** A three-letter code typed in capitals (COP, NOK, PEN, SAR): a ticker as much as a currency. */
function capitalCode(word: string): boolean {
  return /^[A-Z]{3}$/.test(word.trim());
}

/**
 * The pair a word reads as where it is rewritten as one: a pair in any
 * spelling, a currency's name, or a code in lowercase (`eur`). A code in
 * capitals is left as typed, since it may be the ticker (COP is
 * ConocoPhillips, NOK Nokia).
 */
function currencyWordRewrite(word: string): CurrencyWordPair | null {
  return capitalCode(word) ? null : currencyWordPair(word);
}

/** The commands that quote a pair and that convert it and price its forwards. */
function currencyLines(fx: CurrencyWordPair): string[] {
  return [`To quote it: gloom quote ${fx.listing}`, `Rate, conversion and forwards: gloom fx ${fx.pair}`];
}

const TICKER_ARGUMENTS = new Set(["ticker", "tickers", "symbol-list", "ticker-list"]);

/** A company name typed where a ticker goes (`duolingo`, `"coca cola"`): lowercase and longer than a ticker, or several words. */
function nameLike(arg: string): boolean {
  return /\s/.test(arg.trim()) || /^[a-z]{6,}$/.test(arg.trim());
}

function shellWord(arg: string): string {
  return /^[\w.:,=%+@/$^-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/**
 * The command that runs `hit` with what the reader typed after the unknown
 * word: their tickers (`gloom fn RV DUOL --peers`, the switch added when
 * one symbol meets a function that picks its peers), or the function's
 * placeholder and a search when they typed a company's name.
 */
function catalogHitCommand(hit: CatalogCommandHit, args: readonly string[]): { command: string; search: string | null; standIn: string | null } {
  const typed = args.filter((arg) => arg.trim() && !arg.startsWith("-"));
  const base = `gloom fn ${hit.code}`;
  if (hit.argKind === "none") return { command: base, search: null, standIn: null };
  const placeholder = hit.argPlaceholder ?? hit.argKind;
  if (!hit.argKind || !TICKER_ARGUMENTS.has(hit.argKind)) {
    const argument = typed.length > 0 ? typed.map(shellWord).join(" ") : placeholder ? `<${placeholder}>` : "";
    return { command: [base, argument].filter(Boolean).join(" "), search: null, standIn: null };
  }
  // A currency where a ticker goes (`skew eur`) is its pair's listing (EURUSD=X) for a function that takes FX; a
  // function that refuses an FX pair (OVDV) takes the currency fund whose options stand in for it (FXE), so the
  // command shown runs. Any other function, and a code in capitals (COP, NOK), keep the word as typed.
  let standIn: string | null = null;
  const tickers = typed.map((arg) => {
    const fx = currencyWordRewrite(arg);
    if (!fx) return arg;
    if (hit.refusesSymbol?.(fx.listing)) {
      const fund = fxVolatilityProxyFund(fx.code);
      if (fund) standIn = `${fund}'s options stand in for ${fx.pair}: OTC FX volatility is not covered.`;
      return fund ?? arg;
    }
    return hit.takesFx ? fx.listing : arg;
  });
  const names = tickers.filter((arg) => nameLike(arg) && !currencyWordPair(arg));
  const single = tickers.length === 1;
  const peers = hit.peers && single ? " --peers" : "";
  if (names.length > 0) {
    return { command: `${base} <${single ? "ticker" : placeholder ?? "tickers"}>${peers}`, search: `gloom search ${names.map(shellWord).join(" ")}`, standIn };
  }
  return { command: `${base} ${tickers.length > 0 ? tickers.map(shellWord).join(" ") : `<${placeholder ?? "ticker"}>`}${peers}`, search: null, standIn };
}

/**
 * A word typed the way a ticker is written: capitals, with the digits and
 * punctuation of a listing's key (`PLTR`, `BRK.B`, `BTC-USD`, `^GSPC`,
 * `7203:TSE`).
 */
const TICKER_SHAPED = /^\^?[A-Z0-9][A-Z0-9.=-]{0,11}(?::[A-Z0-9]{1,8})?$/;

/**
 * What a ticker typed as a command (`gloom PLTR`) is answered with: the
 * command that quotes it and the search that finds it. Null for a word not
 * written as a ticker.
 */
export function tickerPointer(token: string): string | null {
  const word = token.trim();
  if (!TICKER_SHAPED.test(word) || !/[A-Z]/.test(word)) return null;
  return [`To quote it: gloom quote ${word}`, `Find the ticker: gloom search ${word}`].join("\n");
}

/**
 * What an unknown command word is answered with when it names something the
 * catalog has (`peers`, `comps`): one function as a command to run, several
 * as a list, with the catalog search for more. Null when the catalog has
 * nothing for it.
 */
export function catalogPointer(token: string, hits: readonly CatalogCommandHit[], args: readonly string[]): string | null {
  if (hits.length === 0) return null;
  const word = /^[\w.:-]+$/.test(token) ? token : JSON.stringify(token);
  const more = `gloom catalog ${word}`;
  if (hits.length === 1) {
    const { command, search, standIn } = catalogHitCommand(hits[0]!, args);
    return `Try \`${command}\` (${hits[0]!.label})${search ? `; \`${search}\` finds the ticker` : ""}.${standIn ? ` ${standIn}` : ""} \`${more}\` lists more.`;
  }
  const commands = hits.map((hit) => catalogHitCommand(hit, args));
  const width = Math.max(...commands.map(({ command }) => command.length));
  const searches = [...new Set(commands.flatMap(({ search }) => search ?? []))];
  const standIns = [...new Set(commands.flatMap(({ standIn }) => standIn ?? []))];
  return [
    "Closest functions:",
    ...commands.map(({ command }, index) => `  ${command.padEnd(width)}  ${hits[index]!.label}`),
    ...standIns,
    ...searches.map((search) => `Find the ticker: ${search}`),
    `Search the catalog: ${more}`,
  ].join("\n");
}

/** A command's name and the usage lines its help gives, as `gloom help` prints them. */
export interface CommandUsage {
  name: string;
  usage: readonly string[];
}

/**
 * What a subcommand typed on its own (`gloom position set Izmir THYAO 100 280`)
 * is answered with: the command it belongs to, run with what was typed after
 * it (`gloom portfolio position set Izmir THYAO 100 280`), or each command it
 * belongs to when several share it (`add`). Read from the commands' usage
 * lines; null when no usage line has the word after a command's name.
 */
export function subcommandPointer(
  token: string,
  args: readonly string[],
  commands: readonly CommandUsage[],
): { owners: string[]; run: string[] } | null {
  const word = token.trim().toLowerCase();
  if (!/^[a-z][a-z-]*$/.test(word)) return null;
  const owners = commands.filter((command) => command.usage.some((line) => {
    const [name, sub] = line.trim().split(/\s+/);
    return name === command.name && sub === word;
  }));
  if (owners.length === 0) return null;
  const typed = [word, ...args].map(shellWord).join(" ");
  return { owners: owners.map((command) => command.name), run: owners.map((command) => `gloom ${command.name} ${typed}`) };
}

export interface UnknownCommandPointers {
  /** The word is a function's code: the command that runs it. */
  fn: { code: string; command: string } | null;
  /** The word is a slip from one function's code (RCDF for RDCF), read only when it is no code, no command is close to it and the catalog finds nothing for it. */
  nearFn: { code: string; label: string; command: string } | null;
  /** Functions the catalog finds for the word, read only when it is no code and no command is close to it. */
  hits: CatalogCommandHit[];
  /** What the reader typed after the word, which a pointer runs the function with. */
  args: readonly string[];
}

/**
 * What an unknown command word is answered with, the first that fits: a
 * function's code is pointed at `fn`; a bank figure's name (`nim JPM`) at the
 * Bank section; a currency or a pair typed alone (`eurusd`, `eur`) at
 * `quote` and `fx`; a subcommand typed without its command (`position set`) at
 * the command it belongs to, unless the word is `export` (a flag, `--csv` or
 * `--json`) or written as a ticker (`CASH`), which keep their own answers; a
 * slip from a function's code (`RCDF`) at that function; a typo of a command
 * (`suggestion`) at the command; and a word the catalog knows (`comps`) at the
 * functions it finds. A word written as a ticker is also pointed at `quote`
 * and `search`.
 */
export function unknownCommandReply(
  token: string,
  commands: readonly CommandUsage[],
  pointers: UnknownCommandPointers,
  suggestion: string | null,
): { message: string; details?: string } {
  if (pointers.fn) return { message: `${pointers.fn.code} is a function: ${pointers.fn.command}` };
  // A bank figure's name (`nim JPM`, `deposits WFC`) is where it is: the Bank section of fundamentals, NIM in EQS.
  const bank = bankFigurePointer(token, pointers.args[0] ?? "");
  if (bank) return { message: `Unknown command "${token}": a bank's figures are in the Bank section of fundamentals.`, details: bank.details };
  // A currency or a pair typed alone (`eurusd`, `eur`) is a quote and a rate, whatever command it is a slip from. A
  // code in capitals (COP, NOK) is a ticker too: its ticker answer stands, with the pair's lines after it.
  const currency = pointers.args.length === 0 ? currencyWordPair(token) : null;
  if (currency && !capitalCode(token)) {
    return { message: `Unknown command "${token}": it reads as ${currency.pair}.`,
      details: [...currencyLines(currency), "Run gloom help to see every command."].join("\n") };
  }
  const tickerLines = tickerPointer(token);
  const ticker = tickerLines && currency
    ? [tickerLines, `As a currency it reads as ${currency.pair}: gloom quote ${currency.listing}`, `Rate, conversion and forwards: gloom fx ${currency.pair}`].join("\n")
    : tickerLines;
  // Exporting is a flag, not a command: `export LMT` says how, rather than listing functions that mention exports.
  const exported = exportCommandPointer(token, pointers.args);
  const subcommand = exported || ticker ? null : subcommandPointer(token, pointers.args, commands);
  if (subcommand) {
    const owners = subcommand.owners.length > 1
      ? `${subcommand.owners.slice(0, -1).join(", ")} and ${subcommand.owners.at(-1)}` : subcommand.owners[0];
    return {
      message: `Unknown command "${token}": it is a subcommand of ${owners}.`,
      details: subcommand.run.map((command) => `Run: ${command}`).join("\n"),
    };
  }
  if (!suggestion && pointers.nearFn) {
    return {
      message: `Unknown command "${token}". Did you mean the function ${pointers.nearFn.code} (${pointers.nearFn.label})?`,
      details: [`Run: ${pointers.nearFn.command}`, ticker].filter(Boolean).join("\n"),
    };
  }
  const catalog = suggestion ? null : exported ?? catalogPointer(token, pointers.hits, pointers.args);
  const help = suggestion
    ? `Did you mean ${suggestion}? Run gloom help to see every command.`
    : catalog ? `${catalog}\nRun gloom help to see every command.` : "Run gloom help to see every command.";
  return { message: `Unknown command "${token}".`, details: ticker ? `${ticker}\n${help}` : help };
}
