/**
 * Well-known index roots that people type bare. As a bare symbol each one is
 * another instrument (MOVE is Corvex, MID a fund) or nothing at all (VIX); the
 * index itself is quoted as ^ROOT, or as the symbol the sources list it
 * under where that differs (VHSI is ^HSIL). Every entry is offered as a
 * command to run, so only roots whose symbol returns a quote belong here.
 */
const INDEX_SYMBOLS = new Map([["VHSI", "^HSIL"]]);
const INDEX_ROOTS = new Map([
  ["VIX", "Cboe Volatility Index"],
  ["VVIX", "Cboe VIX of VIX Index"],
  ["VIX9D", "Cboe S&P 500 9-Day Volatility Index"],
  ["VIX3M", "Cboe S&P 500 3-Month Volatility Index"],
  ["VXN", "Cboe Nasdaq-100 Volatility Index"],
  ["OVX", "Cboe Crude Oil ETF Volatility Index"],
  ["GVZ", "Cboe Gold ETF Volatility Index"],
  ["SKEW", "Cboe SKEW Index"],
  ["TNX", "Cboe 10-Year Treasury Yield Index"],
  ["SPX", "S&P 500 Index"],
  ["OEX", "S&P 100 Index"],
  ["MID", "S&P MidCap 400 Index"],
  ["DJI", "Dow Jones Industrial Average"],
  ["NDX", "Nasdaq-100 Index"],
  ["SOX", "PHLX Semiconductor Index"],
  ["RUT", "Russell 2000 Index"],
  ["RUI", "Russell 1000 Index"],
  ["RUA", "Russell 3000 Index"],
  ["MOVE", "ICE BofA MOVE Index"],
  ["NYA", "NYSE Composite Index"],
  ["VHSI", "HSI Volatility Index"],
]);

export interface IndexRoot {
  /** The index's own symbol: ^VIX. */
  symbol: string;
  name: string;
}

/** The index a bare root names (VIX is ^VIX, VHSI ^HSIL); null for any other symbol, ^VIX included. */
export function indexRootFor(symbol: string): IndexRoot | null {
  const root = symbol.trim().toUpperCase();
  const name = INDEX_ROOTS.get(root);
  return name ? { symbol: INDEX_SYMBOLS.get(root) ?? `^${root}`, name } : null;
}

/** "Did you mean ^VIX (Cboe Volatility Index)?" after a bare root that is not a ticker; null for any other symbol. */
export function indexRootSuggestion(symbol: string): string | null {
  const root = indexRootFor(symbol);
  return root ? `Did you mean ${root.symbol} (${root.name})?` : null;
}

/** An index no source here carries, and the funds that track it. */
export interface UncarriedIndex {
  name: string;
  /** Who licenses the index, which is why it is not here. */
  licensor: string;
  /** Funds that track it, as `quote` answers them, with their names. */
  funds: ReadonlyArray<readonly [listing: string, name: string]>;
}

/**
 * Indices whose publishers license them, so no source here quotes them, with
 * the funds that track them (each quoted on 2026-11-09). `codes` are the
 * spellings people type: the name, the publisher's code, Bloomberg's, a
 * quote site's. A code with a caret is matched with it, since a bare TPX is a
 * US ticker; the others by their letters and digits alone.
 */
const UNCARRIED_INDICES: ReadonlyArray<UncarriedIndex & { codes: readonly string[] }> = [
  {
    name: "TOPIX",
    licensor: "JPX",
    codes: ["TOPIX", "TOPIX Index", "Tokyo Stock Price Index", "TPX Index", "^TPX", "^TOPX", "TOPX", "998405", "998405:JPX", "998405.T"],
    funds: [["1306:JPX", "NEXT FUNDS TOPIX ETF"], ["1475:JPX", "iShares Core TOPIX ETF"]],
  },
  {
    name: "JPX-Nikkei Index 400",
    licensor: "JPX and Nikkei",
    codes: ["JPX-Nikkei 400", "JPX-Nikkei Index 400", "JPX Nikkei 400", "JPNK400", "JPNK400 Index", "^JPN400"],
    funds: [["1591:JPX", "NEXT FUNDS JPX-Nikkei 400 ETF"], ["1592:JPX", "Listed Index Fund JPX-Nikkei 400"]],
  },
];

const indexCodeKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The index no source carries that `typed` names (TOPIX, ^TPX, 998405:JPX), else null. */
export function uncarriedIndexFor(typed: string): UncarriedIndex | null {
  const asTyped = typed.trim().toUpperCase();
  const key = indexCodeKey(typed);
  if (!key) return null;
  const found = UNCARRIED_INDICES.find((index) => index.codes.some((code) =>
    code.startsWith("^") ? code.toUpperCase() === asTyped : indexCodeKey(code) === key));
  return found ? { name: found.name, licensor: found.licensor, funds: found.funds } : null;
}

/** "TOPIX is not carried: JPX licenses it. Funds that track it: 1306:JPX (NEXT FUNDS TOPIX ETF), 1475:JPX (…)." */
export function uncarriedIndexLine(index: UncarriedIndex): string {
  return `${index.name} is not carried: ${index.licensor} ${index.licensor.includes(" and ") ? "license" : "licenses"} it. `
    + `Funds that track it: ${index.funds.map(([listing, name]) => `${listing} (${name})`).join(", ")}.`;
}

/** Cboe's Treasury yield indices: 13-week bill, 5-, 10- and 30-year notes. Each level is a yield in percent. */
const YIELD_INDEX_SYMBOLS: ReadonlySet<string> = new Set(["^IRX", "^FVX", "^TNX", "^TYX"]);

export function isYieldIndexSymbol(symbol: string): boolean {
  return YIELD_INDEX_SYMBOLS.has(symbol.trim().toUpperCase());
}
