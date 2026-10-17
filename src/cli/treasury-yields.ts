/**
 * A US Treasury yield typed as if it were a ticker: US10Y, UST10Y, US10YR,
 * USGG10YR, 10Y, TNX, "10 year yield". None is a ticker (TNX is TenX
 * Protocols, TYX an ASX miner), and a name search finds the yield futures at
 * best, so `quote`, `search` and `catalog` name what does have it: the
 * Cboe index, the daily FRED series and the whole curve.
 */
export interface TreasuryYieldTenor {
  /** "10-year". */
  label: string;
  /** FRED's daily constant-maturity series: DGS10. */
  fred: string;
  /** Cboe's yield index, for the four tenors it has: ^TNX. */
  index?: string;
}

const TENORS: ReadonlyMap<string, TreasuryYieldTenor> = new Map([
  ["1m", { label: "1-month", fred: "DGS1MO" }],
  ["3m", { label: "3-month", fred: "DGS3MO", index: "^IRX" }],
  ["6m", { label: "6-month", fred: "DGS6MO" }],
  ["1y", { label: "1-year", fred: "DGS1" }],
  ["2y", { label: "2-year", fred: "DGS2" }],
  ["3y", { label: "3-year", fred: "DGS3" }],
  ["5y", { label: "5-year", fred: "DGS5", index: "^FVX" }],
  ["7y", { label: "7-year", fred: "DGS7" }],
  ["10y", { label: "10-year", fred: "DGS10", index: "^TNX" }],
  ["20y", { label: "20-year", fred: "DGS20" }],
  ["30y", { label: "30-year", fred: "DGS30", index: "^TYX" }],
]);

/** Cboe's yield index roots typed bare. */
const INDEX_ROOTS: ReadonlyMap<string, string> = new Map([["irx", "3m"], ["fvx", "5y"], ["tnx", "10y"], ["tyx", "30y"]]);

const YEAR_UNITS = new Set(["y", "yr", "yrs", "year", "years", "yt"]);
const MONTH_UNITS = new Set(["m", "mo", "mos", "month", "months"]);
/** Words that make a tenor a US Treasury yield: "US", "treasury", "yield". */
const NAMING_WORDS = new Set(["us", "u", "s", "usa", "ust", "usgg", "treasury", "treasuries", "tsy", "yield", "yields", "rate", "rates",
  "note", "notes", "bill", "bills", "t"]);
/** Words that may sit beside it and say nothing more. */
const FILLER_WORDS = new Set(["the", "on", "of", "par", "cmt", "constant", "maturity", "govt", "government"]);

/**
 * The Treasury tenor a text spells, or null. One tenor and nothing that says
 * another market: "10Y" alone, "US10Y", "UST 10yr", "10 year yield",
 * "3-month bill" or a bare Cboe root (TNX). A phrase names the market ("10
 * year" alone does not), and a month needs it even written compactly (3M is
 * the company). Never a caret symbol (^TNX), which `quote` already answers.
 */
export function treasuryYieldTenor(text: string): TreasuryYieldTenor | null {
  const typed = text.trim();
  if (!typed || typed.length > 40 || typed.startsWith("^")) return null;
  const words = typed.toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 1 && INDEX_ROOTS.has(words[0]!)) return TENORS.get(INDEX_ROOTS.get(words[0]!)!)!;
  const at = words.findIndex((word) => /^\d+$/.test(word));
  const unit = words[at + 1];
  if (at < 0 || !unit) return null;
  const tenor = TENORS.get(`${Number(words[at])}${YEAR_UNITS.has(unit) ? "y" : MONTH_UNITS.has(unit) ? "m" : "?"}`);
  const rest = words.filter((_, index) => index !== at && index !== at + 1);
  if (!tenor || !rest.every((word) => NAMING_WORDS.has(word) || FILLER_WORDS.has(word))) return null;
  const named = rest.some((word) => NAMING_WORDS.has(word));
  return named || (!/\s/.test(typed) && YEAR_UNITS.has(unit)) ? tenor : null;
}

/** The commands with the yield: its Cboe index when there is one, its FRED series, the curve. */
function yieldCommands(tenor: TreasuryYieldTenor): Array<readonly [command: string, gives: string]> {
  return [
    ...tenor.index ? [[`gloomberb quote ${tenor.index}`, "Cboe index"] as const] : [],
    [`gloomberb fred ${tenor.fred}`, "daily"],
    ["gloomberb yield-curve", "every tenor"],
  ];
}

/** "US 10-year Treasury yield: gloomberb quote ^TNX (Cboe index), ...", for `search`, `catalog` and a bare root. */
export function treasuryYieldLine(tenor: TreasuryYieldTenor): string {
  return `US ${tenor.label} Treasury yield: ${yieldCommands(tenor).map(([command, gives]) => `${command} (${gives})`).join(", ")}.`;
}

/** "Try `gloomberb quote ^TNX`, ... for the US 10-year Treasury yield.", after "Not a ticker: US10Y." */
export function treasuryYieldHint(tenor: TreasuryYieldTenor): string {
  const commands = yieldCommands(tenor).map(([command]) => `\`${command}\``);
  return `Try ${commands.slice(0, -1).join(", ")} or ${commands.at(-1)} for the US ${tenor.label} Treasury yield.`;
}
