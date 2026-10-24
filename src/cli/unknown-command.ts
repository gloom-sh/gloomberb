/** A function the catalog finds for a word typed as a command (`comps`, `peers`). */
export interface CatalogCommandHit {
  code: string;
  label: string;
  /** What the function takes after its code: `ticker`, `tickers`, `free-text`, `none`... */
  argKind: string | null;
  argPlaceholder: string | null;
  /** It has a `--peers` switch that adds a symbol's competitors (RV). */
  peers: boolean;
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
function catalogHitCommand(hit: CatalogCommandHit, args: readonly string[]): { command: string; search: string | null } {
  const typed = args.filter((arg) => arg.trim() && !arg.startsWith("-"));
  const base = `gloom fn ${hit.code}`;
  if (hit.argKind === "none") return { command: base, search: null };
  const placeholder = hit.argPlaceholder ?? hit.argKind;
  if (!hit.argKind || !TICKER_ARGUMENTS.has(hit.argKind)) {
    const argument = typed.length > 0 ? typed.map(shellWord).join(" ") : placeholder ? `<${placeholder}>` : "";
    return { command: [base, argument].filter(Boolean).join(" "), search: null };
  }
  const names = typed.filter(nameLike);
  const single = typed.length === 1;
  const peers = hit.peers && single ? " --peers" : "";
  if (names.length > 0) {
    return { command: `${base} <${single ? "ticker" : placeholder ?? "tickers"}>${peers}`, search: `gloom search ${names.map(shellWord).join(" ")}` };
  }
  return { command: `${base} ${typed.length > 0 ? typed.map(shellWord).join(" ") : `<${placeholder ?? "ticker"}>`}${peers}`, search: null };
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
    const { command, search } = catalogHitCommand(hits[0]!, args);
    return `Try \`${command}\` (${hits[0]!.label})${search ? `; \`${search}\` finds the ticker` : ""}. \`${more}\` lists more.`;
  }
  const commands = hits.map((hit) => catalogHitCommand(hit, args));
  const width = Math.max(...commands.map(({ command }) => command.length));
  const searches = [...new Set(commands.flatMap(({ search }) => search ?? []))];
  return [
    "Closest functions:",
    ...commands.map(({ command }, index) => `  ${command.padEnd(width)}  ${hits[index]!.label}`),
    ...searches.map((search) => `Find the ticker: ${search}`),
    `Search the catalog: ${more}`,
  ].join("\n");
}
