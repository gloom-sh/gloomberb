/**
 * Text for a terminal that shows only ASCII: a C locale, or a Windows console
 * on a legacy code page (437, 850, 1252), where UTF-8 bytes print as `â€”`.
 * What the CLI writes itself keeps its meaning: a dash is `-`, the `·`
 * between a source line's parts `|`, a price in euros `EUR211.25` (as one in
 * kroner is `NOK393.90`) and one in US cents `447.50c`.
 */

/** Spelled out before single characters, so the yuan's `CN¥` is not read as the yen's `¥`. */
const ASCII_SEQUENCES: ReadonlyArray<readonly [string, string]> = [
  ["CN¥", "CNY"],
  ["JP¥", "JPY"],
];

const ASCII_SPELLINGS: Readonly<Record<string, string>> = {
  // Dashes and the minus sign.
  "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
  // Separators and marks.
  "\u00B7": "|", "\u2022": "*", "\u2026": "...", "\u00A6": "|",
  // Currencies, as their codes; a minor unit as its letter.
  "\u20AC": "EUR", "\u00A3": "GBP", "\u00A5": "JPY", "\u00A2": "c", "\u20B9": "INR", "\u20A9": "KRW", "\u20AA": "ILS",
  "\u20AB": "VND", "\u20B1": "PHP", "\u20BA": "TRY", "\u20BD": "RUB", "\u20A6": "NGN", "\u20B4": "UAH", "\u20B8": "KZT",
  "\u20BF": "BTC", "\u0E3F": "THB",
  // Quotes and primes.
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201C": "\"", "\u201D": "\"", "\u201E": "\"", "\u2032": "'", "\u2033": "\"",
  "\u00AB": "\"", "\u00BB": "\"",
  // Arithmetic.
  "\u00D7": "x", "\u00F7": "/", "\u00B1": "+/-", "\u2248": "~", "\u2264": "<=", "\u2265": ">=", "\u2260": "!=", "\u00B0": "deg",
  "\u00BC": "1/4", "\u00BD": "1/2", "\u00BE": "3/4", "\u2030": "per mille", "\u00B5": "u",
  // Arrows and markers.
  "\u2192": "->", "\u2190": "<-", "\u2191": "^", "\u2193": "v", "\u25B2": "^", "\u25BC": "v", "\u21B5": "Enter",
  "\u2713": "ok", "\u2714": "ok", "\u2717": "x", "\u2715": "x",
  // Box drawing.
  "\u2502": "|", "\u2500": "-", "\u2503": "|", "\u2501": "-",
  // Spaces.
  "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u2007": " ", "\u2002": " ", "\u2003": " ",
  // Letters that do not decompose.
  "\u00DF": "ss", "\u00E6": "ae", "\u00C6": "AE", "\u0153": "oe", "\u0152": "OE", "\u00F8": "o", "\u00D8": "O",
  "\u0111": "d", "\u0110": "D", "\u0142": "l", "\u0141": "L", "\u00FE": "th", "\u00DE": "Th", "\u0131": "i",
  // Signs.
  "\u2122": "(TM)", "\u00AE": "(R)", "\u00A9": "(C)",
};

const NON_ASCII = /[^\x00-\x7F]/;
const COMBINING_MARKS = /[\u0300-\u036F]/g;

/**
 * `text` in ASCII: each character above with its spelling, an accented letter
 * without its accent (Société Générale is Societe Generale), a box or block
 * drawing character as `|`, `-`, `+` or `#`, and anything else as `?`.
 * Escape sequences (colour) are ASCII and pass through.
 */
export function asciiText(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  let folded = text;
  for (const [sequence, spelling] of ASCII_SEQUENCES) folded = folded.split(sequence).join(spelling);
  let out = "";
  for (const character of folded) {
    if (character.charCodeAt(0) < 0x80) {
      out += character;
      continue;
    }
    const spelled = ASCII_SPELLINGS[character];
    if (spelled !== undefined) {
      out += spelled;
      continue;
    }
    const bare = character.normalize("NFD").replace(COMBINING_MARKS, "");
    if (bare && !NON_ASCII.test(bare)) {
      out += bare;
      continue;
    }
    const code = character.codePointAt(0)!;
    // Box drawing (U+2500-257F): corners and joins as +; block elements (U+2580-259F), a bar or sparkline's, as #.
    out += code >= 0x2500 && code <= 0x257F ? "+" : code >= 0x2580 && code <= 0x259F ? "#" : "?";
  }
  return out;
}

type LocaleEnv = Readonly<Record<string, string | undefined>>;

/**
 * The locale text is written in, by the variable POSIX reads first (LC_ALL,
 * then LC_CTYPE, then LANG; an empty one is unset), or null when none is set.
 */
function localeName(env: LocaleEnv): string | null {
  return env.LC_ALL || env.LC_CTYPE || env.LANG || null;
}

/**
 * Whether the terminal may not read UTF-8: a locale that names no UTF-8
 * (`C`, `POSIX`, `en_US.ISO-8859-1`), or a Windows shell that sets none, whose
 * console code page then decides (`consoleReadsUtf8`). A locale that is UTF-8,
 * or none set elsewhere, is taken to read it.
 */
export function localeMayNotReadUtf8(env: LocaleEnv = process.env, platform: string = process.platform): boolean {
  const locale = localeName(env);
  if (locale) return !/utf-?8/i.test(locale);
  return platform === "win32";
}

/**
 * Where Windows keeps `chcp.com`. Windows looks a bare program name up in the
 * current folder before the system's, so a `chcp.com` left in the folder a
 * command runs in would run in its place; the full path never does.
 */
export function windowsChcpPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir, env.WINDIR]
    .find((dir): dir is string => !!dir && /^[A-Za-z]:[\\/]/.test(dir)) ?? "C:\\Windows";
  return `${root.replace(/[\\/]+$/, "")}\\System32\\chcp.com`;
}

/** The console's code page as `chcp` prints it ("Active code page: 437"), or null when it cannot be read. */
function consoleCodePage(): number | null {
  try {
    if (typeof Bun === "undefined" || process.platform !== "win32") return null;
    const answer = Bun.spawnSync([windowsChcpPath()], { stdout: "pipe", stderr: "ignore" });
    const page = /(\d+)\D*$/.exec(answer.stdout.toString().trim());
    return page ? Number(page[1]) : null;
  } catch {
    // Intentional ignore: a console whose code page cannot be read is left to show what it gets.
    return null;
  }
}

/**
 * Whether the terminal reads UTF-8: by the locale when one is set, else on
 * Windows by the console's code page (65001 is UTF-8). A code page that
 * cannot be read is taken to read it, so nothing changes where it is unknown.
 */
export function localeReadsUtf8(
  env: LocaleEnv = process.env,
  platform: string = process.platform,
  codePage: () => number | null = consoleCodePage,
): boolean {
  if (!localeMayNotReadUtf8(env, platform)) return true;
  if (localeName(env)) return false;
  const page = codePage();
  return page == null || page === 65001;
}
